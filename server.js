const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('xmldom');
const QRCode = require('qrcode');
const { parseStringPromise } = require('xml2js');


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
const { parseStringPromise } = require('xml2js');

app.get('/invoice/view/:irn', async (req, res) => {
  const { irn } = req.params;
  const invoice = invoiceStore[irn];

  if (!invoice) {
    return res.status(404).send('Invoice not found');
  }

  try {
    const parsed = await parseStringPromise(invoice.signedXml, {
      explicitArray: false,
      ignoreAttrs: false
    });

    const invoiceData = parsed['Invoice'] || {};

    const html = `
      <html>
        <head>
          <title>Invoice: ${irn}</title>
          <style>
            body { font-family: Arial; padding: 20px; background: #f5f5f5; }
            h1 { color: #003366; }
            .section { margin-bottom: 20px; padding: 10px; background: #fff; border-radius: 5px; }
            .label { font-weight: bold; }
          </style>
        </head>
        <body>
          <h1>Invoice: ${irn}</h1>
          <div class="section">
            <div><span class="label">Issue Date:</span> ${invoiceData.IssueDate || ''}</div>
            <div><span class="label">Due Date:</span> ${invoiceData.DueDate || ''}</div>
            <div><span class="label">Invoice Type:</span> ${invoiceData.InvoiceTypeCode || ''}</div>
            <div><span class="label">Currency:</span> ${invoiceData.DocumentCurrencyCode || ''}</div>
          </div>

          <div class="section">
            <h3>Supplier</h3>
            <div><span class="label">Name:</span> ${invoiceData.AccountingSupplierParty?.Party?.PartyName?.Name || ''}</div>
            <div><span class="label">TIN:</span> ${invoiceData.AccountingSupplierParty?.Party?.PartyIdentification?.ID || ''}</div>
          </div>

          <div class="section">
            <h3>Customer</h3>
            <div><span class="label">Name:</span> ${invoiceData.AccountingCustomerParty?.Party?.PartyName?.Name || ''}</div>
            <div><span class="label">TIN:</span> ${invoiceData.AccountingCustomerParty?.Party?.PartyIdentification?.ID || ''}</div>
          </div>

          <div class="section">
            <h3>Summary</h3>
            <div><span class="label">Payable Amount:</span> ${invoiceData.LegalMonetaryTotal?.PayableAmount?._ || ''} ${invoiceData.LegalMonetaryTotal?.PayableAmount?.$.currencyID || ''}</div>
          </div>

        </body>
      </html>
    `;

    res.send(html);
  } catch (err) {
    console.error('❌ XML Parsing Error:', err.message);
    res.status(500).send('Error rendering invoice');
  }
});



// -- 🚀 Start Server --
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
