const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('xmldom');
const QRCode = require('qrcode');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

const invoiceStore = {}; // { [irn]: { signedXml, json, timestamp } }

const templatePath = path.join(__dirname, 'templates', 'invoice.xml');
const privateKey = fs.readFileSync('./private.pem', 'utf8');

function fillTemplate(template, data) {
  let output = template;

  Object.keys(data).forEach((key) => {
    if (typeof data[key] !== 'object' || data[key] === null) {
      output = output.replaceAll(`{{${key}}}`, data[key]);
    }
  });

  const nestedPaths = [
    'accounting_supplier_party',
    'accounting_customer_party',
    'legal_monetary_total'
  ];

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
    getKeyInfo() {
      return "<X509Data></X509Data>";
    },
  };

  sig.computeSignature(xml);
  return sig.getSignedXml();
}

app.post('/simulate-firs', async (req, res) => {
  try {
    const data = req.body;
    const template = fs.readFileSync(templatePath, 'utf8');
    const filledXml = fillTemplate(template, data);
    const signedXml = signXml(filledXml);

    const invoiceUrl = `https://firs-simulator-production.up.railway.app/verify/${data.irn}`;
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

app.get('/verify/:irn', (req, res) => {
  const { irn } = req.params;
  const record = invoiceStore[irn];

  if (!record) {
    return res.status(404).send(`<h2>Invoice not found ❌</h2>`);
  }

  const { signedXml, json, timestamp } = record;

  res.send(`
    <html>
      <head>
        <title>Invoice Verification</title>
        <style>
          body { font-family: sans-serif; padding: 2rem; background: #f5f5f5; }
          .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .success { color: green; font-size: 1.5rem; font-weight: bold; }
          .section { margin-top: 1.5rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="success">✅ Invoice Verified</div>
          <div class="section"><strong>IRN:</strong> ${irn}</div>
          <div class="section"><strong>Issued To:</strong> ${json.accounting_customer_party.party_name}</div>
          <div class="section"><strong>Supplier:</strong> ${json.accounting_supplier_party.party_name}</div>
          <div class="section"><strong>Amount:</strong> NGN ${json.legal_monetary_total.payable_amount}</div>
          <div class="section"><strong>Issue Date:</strong> ${json.issue_date}</div>
          <div class="section"><strong>Stored:</strong> ${timestamp}</div>
          <div class="section">
            <a href="/verify/${irn}/xml" target="_blank">🔍 View Signed XML</a>
          </div>
        </div>
      </body>
    </html>
  `);
});

app.get('/verify/:irn/xml', (req, res) => {
  const record = invoiceStore[req.params.irn];
  if (!record) return res.status(404).send('Invoice not found');
  res.setHeader('Content-Type', 'application/xml');
  res.send(record.signedXml);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
