const https = require('https');

const PUBLIC_KEY = process.env.ILOVEPDF_PUBLIC_KEY;
const SECRET_KEY = process.env.ILOVEPDF_PRIVATE_KEY;

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ statusCode: res.statusCode, headers: res.headers, buffer, text: buffer.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function apiRequest(hostname, path, method, token, payload) {
  const body = payload ? JSON.stringify(payload) : undefined;
  const res = await httpsRequest({
    hostname,
    path,
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
    }
  }, body);
  console.log(`${method} ${path} -> ${res.statusCode}`);
  try { return { statusCode: res.statusCode, data: JSON.parse(res.text) }; }
  catch { return { statusCode: res.statusCode, data: res.text }; }
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  try {
    console.log('PUBLIC_KEY exists:', !!PUBLIC_KEY);
    console.log('SECRET_KEY exists:', !!SECRET_KEY);

    const body = JSON.parse(event.body);
    const fileBuffer = Buffer.from(body.file, 'base64');
    const fileName = body.fileName || 'documento.docx';
    console.log('File:', fileName, 'Size:', fileBuffer.length);

    // STEP 1: Auth
    const authPayload = JSON.stringify({ public_key: PUBLIC_KEY });
    const authRes = await httpsRequest({
      hostname: 'api.ilovepdf.com',
      path: '/v1/auth',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(authPayload) }
    }, authPayload);

    console.log('Auth status:', authRes.statusCode, authRes.text.substring(0, 200));
    if (authRes.statusCode !== 200) return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Auth failed', detail: authRes.text }) };

    const { token } = JSON.parse(authRes.text);

    // STEP 2: Start task
    const startRes = await httpsRequest({
      hostname: 'api.ilovepdf.com',
      path: '/v1/start/officepdf',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    console.log('Start status:', startRes.statusCode, startRes.text.substring(0, 200));
    if (startRes.statusCode !== 200) return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Start failed', detail: startRes.text }) };

    const { server, task } = JSON.parse(startRes.text);
    console.log('Server:', server, 'Task:', task);

    // STEP 3: Upload
    const boundary = `----FormBoundary${Date.now()}`;
    const CRLF = '\r\n';
    const header = Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="task"${CRLF}${CRLF}${task}${CRLF}` +
      `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`
    );
    const footer = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
    const multipart = Buffer.concat([header, fileBuffer, footer]);

    const uploadRes = await httpsRequest({
      hostname: server,
      path: '/v1/upload',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': multipart.length
      }
    }, multipart);

    console.log('Upload status:', uploadRes.statusCode, uploadRes.text.substring(0, 200));
    if (uploadRes.statusCode !== 200) return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Upload failed', detail: uploadRes.text }) };

    const { server_filename } = JSON.parse(uploadRes.text);

    // STEP 4: Process
    const processPayload = JSON.stringify({
      task, tool: 'officepdf',
      files: [{ server_filename, filename: fileName }]
    });

    const processRes = await httpsRequest({
      hostname: server,
      path: '/v1/process',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(processPayload) }
    }, processPayload);

    console.log('Process status:', processRes.statusCode, processRes.text.substring(0, 200));
    if (processRes.statusCode !== 200) return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Process failed', detail: processRes.text }) };

    // STEP 5: Download
    const downloadRes = await httpsRequest({
      hostname: server,
      path: `/v1/download/${task}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    console.log('Download status:', downloadRes.statusCode, 'Size:', downloadRes.buffer.length);
    if (downloadRes.statusCode !== 200) return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Download failed' }) };

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdf: downloadRes.buffer.toString('base64'),
        fileName: fileName.replace(/\.docx?$/i, '.pdf')
      })
    };

  } catch (err) {
    console.error('Error:', err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
