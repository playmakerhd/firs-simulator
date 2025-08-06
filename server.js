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
function fillTemplate(template, data) {
  return template
    .replace('{{irn}}', data.irn)
    .replace('{{issue_date}}', data.issue_date)
    .replace('{{supplier_name}}', data.accounting_supplier_party.party_name)
    .replace('{{supplier_tin}}', data.accounting_supplier_party.tin)
    .replace('{{customer_name}}', data.accounting_customer_party.party_name)
    .replace('{{customer_tin}}', data.accounting_customer_party.tin)
    .replace('{{payable_amount}}', data.legal_monetary_total.payable_amount.toString());
}

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

