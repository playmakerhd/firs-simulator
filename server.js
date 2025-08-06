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

// -- 🔍 View Invoice from QR --
app.get('/invoice/view/:irn', async (req, res) => {
  const { irn } = req.params;
  const invoice = invoiceStore[irn];

  if (!invoice) {
    return res.status(404).send('Invoice not found');
  }

  const xml = invoice.signedXml;

  try {
    const parsed = await parseStringPromise(xml, {
      explicitArray: false,
      mergeAttrs: true,
    });

    // Assuming the Invoice node is under this path
    const invoiceData = parsed['Invoice'] || parsed['cbc:Invoice'];

    if (!invoiceData) {
      return res.status(500).send('Failed to parse invoice');
    }

    // Generate a simple HTML view
    let html = `<html><head><title>Invoice ${irn}</title></head><body>`;
    html += `<h1>Invoice #${irn}</h1>`;
    html += `<ul>`;

    Object.entries(invoiceData).forEach(([key, value]) => {
      if (typeof value === 'object') {
        html += `<li><strong>${key}:</strong><ul>`;
        Object.entries(value).forEach(([subKey, subVal]) => {
          html += `<li>${subKey}: ${JSON.stringify(subVal)}</li>`;
        });
        html += `</ul></li>`;
      } else {
        html += `<li><strong>${key}:</strong> ${value}</li>`;
      }
    });

    html += `</ul></body></html>`;
    res.send(html);
  } catch (err) {
    console.error('❌ XML Parse Error:', err);
    res.status(500).send('Failed to render invoice');
  }
});




// -- 🚀 Start Server --
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
