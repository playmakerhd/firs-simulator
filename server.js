const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('xmldom');
const QRCode = require('qrcode');
const { parseStringPromise } = require('xml2js');
require('dotenv').config();

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

  sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";

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
app.get('/invoice/view/:irn', async (req, res) => {
  const { irn } = req.params;
  const invoice = invoiceStore[irn];

  if (!invoice) {
    return res.status(404).send('Invoice not found');
  }

  try {
    const xml = invoice.signedXml;
    const parsed = await parseStringPromise(xml, { explicitArray: false });
    const data = parsed['Invoice'];

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Invoice ${data.ID}</title>
          <style>
            body { font-family: sans-serif; padding: 30px; line-height: 1.6; }
            h1 { color: #003366; }
            table { border-collapse: collapse; width: 100%; margin-top: 20px; }
            th, td { padding: 10px; border: 1px solid #ccc; text-align: left; }
            .xml-block { background: #f7f7f7; padding: 10px; white-space: pre-wrap; margin-top: 30px; font-size: 13px; }
          </style>
        </head>
        <body>
          <h1>Invoice: ${data.ID}</h1>
          <p><strong>Issue Date:</strong> ${data.IssueDate}</p>
          <p><strong>Supplier:</strong> ${data.AccountingSupplierParty?.PartyName}</p>
          <p><strong>Customer:</strong> ${data.AccountingCustomerParty?.PartyName}</p>
          <p><strong>Payable Amount:</strong> ${data.PayableAmount?._} ${data.PayableAmount?.$.currencyID}</p>

          <div class="xml-block">
            <strong>Signed XML:</strong>
            <pre>${xml}</pre>
          </div>
        </body>
      </html>
    `;

    res.send(html);
  } catch (err) {
    console.error('❌ Error rendering invoice view:', err.message);
    res.status(500).send('Failed to render invoice');
  }
});

// -- 🚀 Start Server --
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
