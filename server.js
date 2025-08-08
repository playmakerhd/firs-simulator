const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('xmldom');
const QRCode = require('qrcode');
const { parseStringPromise } = require('xml2js');
const express   = require('express');   // or `import …` if you're using ESM
const puppeteer = require('puppeteer');
const router    = express.Router();
const app = express();
app.use(bodyParser.json());
const PORT = process.env.PORT || 3000;
const invoiceStore = {}; // 🧠 In-memory store
const privateKey = fs.readFileSync('./private.pem', 'utf8');
const templatePath = path.join(__dirname, 'templates', 'invoice.xml');
// -- 🧩 Template Filler Function --
function fillTemplate(template, data) {
  let output = template;
  Object.keys(data).forEach((key) => {
    if (typeof data[key] !== 'object' || data[key] === null) {
      output = output.replaceAll(`{{${key}}}`, data[key]);
    }
  });
  const nestedPaths = ['accounting_supplier_party', 'accounting_customer_party', 'legal_monetary_total'];
  nestedPaths.forEach((section) => {
    if (data[section]) {
      Object.keys(data[section]).forEach((key) => {
        if (typeof data[section][key] !== 'object') {
          output = output.replaceAll(`{{${section}.${key}}}`, data[section][key]);
        } else {
          Object.keys(data[section][key]).forEach((subKey) => {
            output = output.replaceAll(`{{${section}.${key}.${subKey}}}`, data[section][key][subKey]);
          });
        }
      });
    }
  });
  const lineTemplateMatch = output.match(/{{#each invoice_line}}([\s\S]*?){{\/each}}/);
  if (lineTemplateMatch) {
    const lineTemplate = lineTemplateMatch[1];
    const invoiceLines = data.invoice_line || [];
    let fullLineBlock = '';
    invoiceLines.forEach((line, index) => {
      let renderedLine = lineTemplate;
      renderedLine = renderedLine.replaceAll('{{@index}}', index + 1);
      Object.keys(line).forEach((lineKey) => {
        if (typeof line[lineKey] !== 'object') {
          renderedLine = renderedLine.replaceAll(`{{${lineKey}}}`, line[lineKey]);
        } else {
          Object.keys(line[lineKey]).forEach((subKey) => {
            renderedLine = renderedLine.replaceAll(`{{${lineKey}.${subKey}}}`, line[lineKey][subKey]);
          });
        }
      });
      fullLineBlock += renderedLine;
    });
    output = output.replace(lineTemplateMatch[0], fullLineBlock);
  }
  return output;
}
// -- 🔏 Sign the XML --
function signXml(xml) {
  const sig = new SignedXml();
  // ✅ Add digestAlgorithm explicitly
  sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  sig.digestAlgorithm = "http://www.w3.org/2001/04/xmlenc#sha256";
  sig.addReference(
    "//*[local-name(.)='Invoice']",
    ["http://www.w3.org/2000/09/xmldsig#enveloped-signature"],
    "http://www.w3.org/2001/04/xmlenc#sha256"
  );
  sig.signingKey = privateKey;
  sig.keyInfoProvider = {
    getKeyInfo: () => "<X509Data></X509Data>"
  };
  sig.computeSignature(xml);
  return sig.getSignedXml();
}
// -- 📥 /simulate-firs Endpoint --
app.post('/simulate-firs', async (req, res) => {
  try {
    const data = req.body;
    const template = fs.readFileSync(templatePath, 'utf8');
    const filledXml = fillTemplate(template, data);
    const signedXml = signXml(filledXml);
    const invoiceUrl = `https://firs-simulator-production.up.railway.app/invoice/view/${data.irn}`;
    const qrCode = await QRCode.toDataURL(invoiceUrl);
    // Save to in-memory store
    invoiceStore[data.irn] = {
      signedXml,
      json: data,
      timestamp: new Date().toISOString()
    };
    res.json({
      irn: data.irn,
      qr_code_base64: qrCode.replace(/^data:image\/png;base64,/, ''),
      signed_xml: signedXml,
    });
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: 'Failed to process invoice' });
  }
});
// -- 🔍 View Invoice from QR --
// -- 🔍 View Invoice from QR --
app.get('/invoice/view/:irn', async (req, res) => {
  const { irn } = req.params;
  const invoice = invoiceStore[irn];
  if (!invoice) return res.status(404).send('Invoice not found');
  const xml = invoice.signedXml;
  try {
    const parsed = await parseStringPromise(xml, {
      explicitArray: false,
      mergeAttrs: true,
    });
    const inv = parsed['Invoice'];
    const supplier = inv['cac:AccountingSupplierParty']?.['cac:Party'];
    const customer = inv['cac:AccountingCustomerParty']?.['cac:Party'];
    const totals = inv['cac:LegalMonetaryTotal'];
    const lines = Array.isArray(inv['cac:InvoiceLine'])
      ? inv['cac:InvoiceLine']
      : [inv['cac:InvoiceLine']];
    const lineRows = lines.map((line) => {
      const item = line['cac:Item'];
      const price = line['cac:Price']?.[0];
      console.log(JSON.stringify({ price, line }, null, 2));
      return `
        <tr>
          <td>${item?.['cbc:Name']}</td>
          <td>${item?.['cbc:Description']}</td>
          <td>${line?.['cbc:InvoicedQuantity']}</td>
        <td>${price?.['cbc:PriceAmount']?.[0]?._ || ''} ${price?.['cbc:PriceAmount']?.[0]?.$?.currencyID || ''}</td>
      <td>${line['cbc:LineExtensionAmount']?.[0]?._ || ''} ${line['cbc:LineExtensionAmount']?.[0]?.$?.currencyID || ''}</td>
        </tr>`;
    }).join('');
    const html = `
      <html>
      <head>
        <title>Invoice ${irn}</title>
        <style>
          body { font-family: Arial; padding: 20px; line-height: 1.6; }
          h2 { border-bottom: 1px solid #ccc; }
          table { width: 100%; border-collapse: collapse; margin-top: 10px; }
          th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
          th { background-color: #f4f4f4; }
        </style>
      </head>
      <body>
        <h1>Invoice #${irn}</h1>
        <h2>Supplier</h2>
        <p><strong>Name:</strong> ${supplier?.['cbc:Name']}</p>
        <p><strong>TIN:</strong> ${supplier?.['cbc:CompanyID']}</p>
        <p><strong>Email:</strong> ${supplier?.['cbc:Email']}</p>
        <h2>Customer</h2>
        <p><strong>Name:</strong> ${customer?.['cbc:Name']}</p>
        <p><strong>TIN:</strong> ${customer?.['cbc:CompanyID']}</p>
        <p><strong>Email:</strong> ${customer?.['cbc:Email']}</p>
        <h2>Invoice Details</h2>
        <p><strong>Issue Date:</strong> ${inv['cbc:IssueDate']}</p>
        <p><strong>Due Date:</strong> ${inv['cbc:DueDate']}</p>
        <p><strong>Currency:</strong> ${inv['cbc:DocumentCurrencyCode']}</p>
        <h2>Items</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>${lineRows}</tbody>
        </table>
        <h2>Totals</h2>
        <p><strong>Line Extension:</strong> ${totals?.['cbc:LineExtensionAmount']?._}</p>
        <p><strong>Tax Exclusive:</strong> ${totals?.['cbc:TaxExclusiveAmount']?._}</p>
        <p><strong>Tax Inclusive:</strong> ${totals?.['cbc:TaxInclusiveAmount']?._}</p>
        <p><strong>Payable:</strong> ${totals?.['cbc:PayableAmount']?._}</p>
        
      </body>
      </html>
    `;
    res.send(html);
  } catch (err) {
    console.error('❌ XML Parse Error:', err);
    res.status(500).send('Failed to render invoice');
  }
});
router.get('/invoice/pdf/:irn', async (req, res) => {
  const { irn } = req.params;
  const browser = await puppeteer.launch({ headless: 'new' });
  const page    = await browser.newPage();
  const htmlUrl = `${req.protocol}://${req.get('host')}/invoice/view/${irn}`;
  await page.goto(htmlUrl, { waitUntil: 'networkidle0' });
  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
  });
  await browser.close();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=invoice_${irn}.pdf`);
  res.send(pdfBuffer);
});
module.exports = router;   // ESM: export default router;
// -- 🚀 Start Server --
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});