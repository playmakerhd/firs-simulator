const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { SignedXml } = require('xml-crypto');
const QRCode = require('qrcode');
const { parseStringPromise } = require('xml2js');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const invoiceStore = {}; // In-memory store

const privateKey = fs.readFileSync('./private.pem', 'utf8');
const templatePath = path.join(__dirname, 'templates', 'invoice.xml');

// Fill XML Template
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

  const lineMatch = output.match(/{{#each invoice_line}}([\s\S]*?){{\/each}}/);
  if (lineMatch) {
    const lineTemplate = lineMatch[1];
    const invoiceLines = data.invoice_line || [];
    let fullLineBlock = '';
    invoiceLines.forEach((line, index) => {
      let rendered = lineTemplate.replaceAll('{{@index}}', index + 1);
      Object.keys(line).forEach((key) => {
        if (typeof line[key] !== 'object') {
          rendered = rendered.replaceAll(`{{${key}}}`, line[key]);
        } else {
          Object.keys(line[key]).forEach((subKey) => {
            rendered = rendered.replaceAll(`{{${key}.${subKey}}}`, line[key][subKey]);
          });
        }
      });
      fullLineBlock += rendered;
    });
    output = output.replace(lineMatch[0], fullLineBlock);
  }

  return output;
}

// Sign XML
function signXml(xml) {
  const sig = new SignedXml();
  sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  sig.addReference(
    "//*[local-name(.)='Invoice']",
    ["http://www.w3.org/2000/09/xmldsig#enveloped-signature"],
    "http://www.w3.org/2001/04/xmlenc#sha256"
  );
  sig.signingKey = privateKey;
  sig.keyInfoProvider = { getKeyInfo: () => "<X509Data></X509Data>" };
  sig.computeSignature(xml);
  return sig.getSignedXml();
}

// Simulate FIRS endpoint
app.post('/simulate-firs', async (req, res) => {
  try {
    const data = req.body;
    const template = fs.readFileSync(templatePath, 'utf8');
    const filledXml = fillTemplate(template, data);
    const signedXml = signXml(filledXml);
    const invoiceUrl = `https://firs-simulator-production.up.railway.app/invoice/view/${data.irn}`;
    const qrCode = await QRCode.toDataURL(invoiceUrl);

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

// Render Invoice Viewer
app.get('/invoice/view/:irn', async (req, res) => {
  const { irn } = req.params;
  const invoice = invoiceStore[irn];
  if (!invoice) return res.status(404).send('Invoice not found');

  try {
    const result = await parseStringPromise(invoice.signedXml, { explicitArray: false });
    const inv = result.Invoice;

    const html = `
      <html>
      <head>
        <title>Invoice View: ${irn}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; padding: 0; background: #f7f7f7; }
          .container { max-width: 800px; background: #fff; padding: 20px; margin: auto; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          h2 { border-bottom: 2px solid #ccc; padding-bottom: 5px; margin-bottom: 10px; }
          .section { margin-bottom: 20px; }
          .label { font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2>Invoice IRN: ${inv.ID}</h2>

          <div class="section">
            <div><span class="label">Issue Date:</span> ${inv.IssueDate}</div>
            <div><span class="label">Payable Amount:</span> ${inv.PayableAmount._} ${inv.PayableAmount.$.currencyID}</div>
          </div>

          <div class="section">
            <h3>Supplier</h3>
            <div><span class="label">Name:</span> ${inv.AccountingSupplierParty.PartyName}</div>
            <div><span class="label">TIN:</span> ${inv.AccountingSupplierParty.TIN}</div>
          </div>

          <div class="section">
            <h3>Customer</h3>
            <div><span class="label">Name:</span> ${inv.AccountingCustomerParty.PartyName}</div>
            <div><span class="label">TIN:</span> ${inv.AccountingCustomerParty.TIN}</div>
          </div>

          <div class="section">
            <h3>Signature</h3>
            <div><pre>${inv.Signature.SignatureValue}</pre></div>
          </div>
        </div>
      </body>
      </html>
    `;

    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send('Failed to render invoice');
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
