// ─────────────────────────────────────────────────────────────
//  server.js   (CommonJS, Node ≥18)
// ─────────────────────────────────────────────────────────────
const express          = require('express');
const bodyParser       = require('body-parser');
const fs               = require('fs');
const path             = require('path');
const { SignedXml }    = require('xml-crypto');
const { DOMParser }    = require('xmldom');             // still needed by xml-crypto
const { parseStringPromise } = require('xml2js');
const QRCode           = require('qrcode');
const puppeteer        = require('puppeteer');          // npm i puppeteer

// ── CONFIG ───────────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const privateKey   = fs.readFileSync('./private.pem', 'utf8');
const templatePath = path.join(__dirname, 'templates', 'invoice.xml');

// 🧠 In-memory “database” (swap for Mongo/SQL later)
const invoiceStore = {};

// ── UTILS ────────────────────────────────────────────────────
function fillTemplate(template, data) {
  let output = template;

  // flat keys
  for (const k of Object.keys(data)) {
    if (typeof data[k] !== 'object' || data[k] === null) {
      output = output.replaceAll(`{{${k}}}`, data[k]);
    }
  }

  // known nested objects
  const nested = [
    'accounting_supplier_party',
    'accounting_customer_party',
    'legal_monetary_total',
  ];
  nested.forEach(section => {
    if (!data[section]) return;
    for (const k of Object.keys(data[section])) {
      if (typeof data[section][k] !== 'object') {
        output = output.replaceAll(`{{${section}.${k}}}`, data[section][k]);
      } else {
        for (const sk of Object.keys(data[section][k])) {
          output = output.replaceAll(
            `{{${section}.${k}.${sk}}}`,
            data[section][k][sk]
          );
        }
      }
    }
  });

  // repeating invoice_line block
  const match = output.match(/{{#each invoice_line}}([\s\S]*?){{\/each}}/);
  if (match) {
    const lineTpl   = match[1];
    const fullBlock = (data.invoice_line || []).map((line, idx) => {
      let rendered = lineTpl.replaceAll('{{@index}}', idx + 1);
      for (const k of Object.keys(line)) {
        if (typeof line[k] !== 'object') {
          rendered = rendered.replaceAll(`{{${k}}}`, line[k]);
        } else {
          for (const sk of Object.keys(line[k])) {
            rendered = rendered.replaceAll(
              `{{${k}.${sk}}}`,
              line[k][sk]
            );
          }
        }
      }
      return rendered;
    }).join('');
    output = output.replace(match[0], fullBlock);
  }

  return output;
}

function signXml(xml) {
  const sig = new SignedXml();
  sig.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  sig.digestAlgorithm    = 'http://www.w3.org/2001/04/xmlenc#sha256';
  sig.addReference(
    "//*[local-name(.)='Invoice']",
    ['http://www.w3.org/2000/09/xmldsig#enveloped-signature'],
    'http://www.w3.org/2001/04/xmlenc#sha256'
  );
  sig.signingKey = privateKey;
  sig.keyInfoProvider = { getKeyInfo: () => '<X509Data></X509Data>' };
  sig.computeSignature(xml);
  return sig.getSignedXml();
}

// ── APP ─────────────────────────────────────────────────────
const app = express();
app.use(bodyParser.json());

// 1️⃣  Create invoice, sign & return QR code
app.post('/simulate-firs', async (req, res) => {
  try {
    const data       = req.body;
    const template   = fs.readFileSync(templatePath, 'utf8');
    const filledXml  = fillTemplate(template, data);
    const signedXml  = signXml(filledXml);
    const viewUrl    = `${req.protocol}://${req.get('host')}/invoice/view/${data.irn}`;
    const qrCodeB64  = await QRCode.toDataURL(viewUrl);

    invoiceStore[data.irn] = { signedXml, json: data, created: Date.now() };

    res.json({
      irn: data.irn,
      qr_code_base64: qrCodeB64.replace(/^data:image\/png;base64,/, ''),
      signed_xml: signedXml,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process invoice' });
  }
});

// 2️⃣  HTML view
app.get('/invoice/view/:irn', async (req, res) => {
  const { irn } = req.params;
  const invoice = invoiceStore[irn];
  if (!invoice) return res.status(404).send('Invoice not found');

  try {
    const parsed  = await parseStringPromise(invoice.signedXml, { explicitArray: false, mergeAttrs: true });
    const inv     = parsed.Invoice;
    const supplier= inv['cac:AccountingSupplierParty']?.['cac:Party'] || {};
    const customer= inv['cac:AccountingCustomerParty']?.['cac:Party'] || {};
    const totals  = inv['cac:LegalMonetaryTotal'] || {};

    const lines   = Array.isArray(inv['cac:InvoiceLine'])
                    ? inv['cac:InvoiceLine']
                    : [inv['cac:InvoiceLine']];

    const rows = lines.map(line => {
      const item = line['cac:Item'];
      const price= line['cac:Price']?.[0];
      return `<tr>
        <td>${item?.['cbc:Name']}</td>
        <td>${item?.['cbc:Description']}</td>
        <td>${line['cbc:InvoicedQuantity']}</td>
        <td>${price?.['cbc:PriceAmount'][0]._} ${price?.['cbc:PriceAmount'][0].$.currencyID}</td>
        <td>${line['cbc:LineExtensionAmount'][0]._} ${line['cbc:LineExtensionAmount'][0].$.currencyID}</td>
      </tr>`;
    }).join('');

    res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Invoice ${irn}</title>
  <style>
    body{font-family:Arial;padding:20px;line-height:1.5}
    h2{border-bottom:1px solid #ccc}
    table{width:100%;border-collapse:collapse;margin-top:8px}
    th,td{border:1px solid #ccc;padding:6px;text-align:left}
    th{background:#f4f4f4}
    button{margin-top:20px;padding:8px 14px}
  </style>
</head>
<body>
  <h1>Invoice #${irn}</h1>
  <h2>Supplier</h2>
  <p><b>Name:</b> ${supplier['cbc:Name']}</p>
  <p><b>TIN:</b> ${supplier['cbc:CompanyID']}</p>

  <h2>Customer</h2>
  <p><b>Name:</b> ${customer['cbc:Name']}</p>
  <p><b>TIN:</b> ${customer['cbc:CompanyID']}</p>

  <h2>Items</h2>
  <table>
    <thead><tr><th>Name</th><th>Description</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <h2>Totals</h2>
  <p><b>Payable:</b> ${totals['cbc:PayableAmount']?._}</p>

  <button id="dl">Download PDF</button>
  <script>
    document.getElementById('dl').addEventListener('click', () => {
      location.href = '/invoice/pdf/${irn}';
    });
  </script>
</body>
</html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to render invoice');
  }
});

// 3️⃣  PDF download
app.get('/invoice/pdf/:irn', async (req, res) => {
  const { irn } = req.params;
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.goto(`${req.protocol}://${req.get('host')}/invoice/view/${irn}`, { waitUntil: 'networkidle0' });

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=invoice_${irn}.pdf`,
    }).send(pdf);

  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to generate PDF');
  } finally {
    if (browser) await browser.close();
  }
});

// ── START ────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => console.log(`🚀  Server running at http://localhost:${PORT}`));
