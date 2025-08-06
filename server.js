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

// Load the XML template
const templatePath = path.join(__dirname, 'templates', 'invoice.xml');
const privateKey = fs.readFileSync('./private.pem', 'utf8');

// Replace placeholders like {{irn}} with actual values
const fs = require('fs');
const path = require('path');

function fillTemplate(template, data) {
  let output = template;

  // Replace top-level fields
  Object.keys(data).forEach((key) => {
    if (typeof data[key] !== 'object' || data[key] === null) {
      output = output.replaceAll(`{{${key}}}`, data[key]);
    }
  });

  // Replace nested fields (supplier and customer)
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

  // Handle invoice_line array manually
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

module.exports = fillTemplate;


// Sign the XML
function signXml(xml) {
  const sig = new SignedXml();

  sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";

  sig.addReference(
    "//*[local-name(.)='Invoice']",
    ["http://www.w3.org/2000/09/xmldsig#enveloped-signature"],
    "http://www.w3.org/2001/04/xmlenc#sha256"
  );

  sig.signingKey = privateKey;

  // This line is CRITICAL for new xml-crypto versions
  sig.keyInfoProvider = {
    getKeyInfo() {
      return "<X509Data></X509Data>"; // Optional placeholder
    },
  };

  sig.computeSignature(xml);
  return sig.getSignedXml();
}





// Route: Simulate FIRS
app.post('/simulate-firs', async (req, res) => {
  try {
    const data = req.body;

    const template = fs.readFileSync(templatePath, 'utf8');
    const filledXml = fillTemplate(template, data);
    const signedXml = signXml(filledXml);

    const invoiceUrl = `https://yourdomain.com/invoice/view/${data.irn}`;

    // For simulation, encode the URL or XML
    const qrCode = await QRCode.toDataURL(invoiceUrl);

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

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

