const https = require('https');
const http = require('http');

const PUBLIC_KEY = process.env.ILOVEPDF_PUBLIC_KEY;
const SECRET_KEY = process.env.ILOVEPDF_SECRET_KEY;

// Helper: make HTTP/HTTPS request
function request(options, body) {
  return new Promise((resolve, reject) => {
    const protocol = options.protocol === 'http:' ? http : https;
    const req = protocol.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (options.binary) {
          resolve({ statusCode: res.statusCode, body: buffer, headers: res.headers });
        } else {
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(buffer.toString()), headers: res.headers });
          } catch {
            resolve({ statusCode: res.statusCode, body: buffer.toString(), headers: res.headers });
          }
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Helper: multipart form data
function buildMultipart(boundary, fields, fileBuffer, fileName) {
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
    );
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`
  );
  const header = Buffer.from(parts.join(''));
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  return Buffer.concat([header, fileBuffer, footer]);
}

exports.handler = async (event) => {
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };
  }

  try {
    // Parse incoming file (base64 encoded)
    const body = JSON.parse(event.body);
    const fileBase64 = body.file; // base64 string
    const fileName = body.fileName || 'documento.docx';
    const fileBuffer = Buffer.from(fileBase64, 'base64');

    // ── STEP 1: Authenticate ──
    const authBody = JSON.stringify({ public_key: PUBLIC_KEY });
    const authRes = await request({
      hostname: 'api.ilovepdf.com',
      path: '/v1/auth',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(authBody)
      }
    }, authBody);

    if (authRes.statusCode !== 200) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Auth failed', details: authRes.body })
      };
    }
    const token = authRes.body.token;

    // ── STEP 2: Start task (officepdf = Word to PDF) ──
    const startRes = await request({
      hostname: 'api.ilovepdf.com',
      path: '/v1/start/officepdf',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (startRes.statusCode !== 200) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Start task failed', details: startRes.body })
      };
    }

    const { server, task } = startRes.body;

    // ── STEP 3: Upload file ──
    const boundary = `----FormBoundary${Date.now()}`;
    const formData = buildMultipart(boundary, { task }, fileBuffer, fileName);

    const uploadRes = await request({
      hostname: server,
      path: '/v1/upload',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': formData.length
      }
    }, formData);

    if (uploadRes.statusCode !== 200) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Upload failed', details: uploadRes.body })
      };
    }

    const serverFilename = uploadRes.body.server_filename;

    // ── STEP 4: Process ──
    const processBody = JSON.stringify({
      task,
      tool: 'officepdf',
      files: [{ server_filename: serverFilename, filename: fileName }]
    });

    const processRes = await request({
      hostname: server,
      path: '/v1/process',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(processBody)
      }
    }, processBody);

    if (processRes.statusCode !== 200) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Process failed', details: processRes.body })
      };
    }

    // ── STEP 5: Download PDF ──
    const downloadRes = await request({
      hostname: server,
      path: `/v1/download/${task}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
      binary: true
    });

    if (downloadRes.statusCode !== 200) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Download failed' })
      };
    }

    // Return PDF as base64
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        pdf: downloadRes.body.toString('base64'),
        fileName: fileName.replace(/\.docx?$/i, '.pdf')
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message })
    };
  }
};
