const https = require('https');

const CLOUDCONVERT_API_KEY = process.env.CLOUDCONVERT_API_KEY;

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

async function apiRequest(path, method, payload) {
  const body = payload ? JSON.stringify(payload) : undefined;
  const res = await httpsRequest({
    hostname: 'api.cloudconvert.com',
    path,
    method,
    headers: {
      'Authorization': `Bearer ${CLOUDCONVERT_API_KEY}`,
      'Content-Type': 'application/json',
      ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
    }
  }, body);
  console.log(`${method} ${path} -> ${res.statusCode}`);
  try { return { statusCode: res.statusCode, data: JSON.parse(res.text) }; }
  catch { return { statusCode: res.statusCode, data: res.text }; }
}

async function waitForJob(jobId, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await apiRequest(`/v2/jobs/${jobId}`, 'GET');
    const status = res.data && res.data.data && res.data.data.status;
    console.log(`Job ${jobId} status: ${status} (attempt ${i + 1})`);
    if (status === 'finished') return res.data.data;
    if (status === 'error') throw new Error(`Job failed: ${JSON.stringify(res.data)}`);
  }
  throw new Error('Job timeout after 60 seconds');
}

async function downloadFromUrl(url) {
  return new Promise((resolve, reject) => {
    function doRequest(reqUrl) {
      const urlObj = new URL(reqUrl);
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET'
      }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          doRequest(res.headers.location);
          return;
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.end();
    }
    doRequest(url);
  });
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
    console.log('API Key exists:', !!CLOUDCONVERT_API_KEY);

    const body = JSON.parse(event.body);
    const fileBuffer = Buffer.from(body.file, 'base64');
    const fileName = body.fileName || 'documento.doc';
    const targetFormat = body.targetFormat || 'pdf';
    const inputFormat = fileName.toLowerCase().endsWith('.docx') ? 'docx' : 'doc';

    console.log('File:', fileName, 'Size:', fileBuffer.length, 'Format:', inputFormat, '->', targetFormat);

    // STEP 1: Create job
    const jobRes = await apiRequest('/v2/jobs', 'POST', {
      tasks: {
        'upload-file': { operation: 'import/upload' },
        'convert-file': {
          operation: 'convert',
          input: 'upload-file',
          input_format: inputFormat,
          output_format: targetFormat
        },
        'export-file': {
          operation: 'export/url',
          input: 'convert-file'
        }
      }
    });

    if (jobRes.statusCode !== 201) throw new Error(`Create job failed (${jobRes.statusCode}): ${JSON.stringify(jobRes.data)}`);

    const job = jobRes.data.data;
    const jobId = job.id;
    console.log('Job ID:', jobId);

    // Find upload task
    const uploadTask = job.tasks.find(t => t.name === 'upload-file');
    if (!uploadTask) throw new Error('Upload task not found in job');

    const uploadUrl = uploadTask.result && uploadTask.result.form && uploadTask.result.form.url;
    const uploadParams = uploadTask.result && uploadTask.result.form && uploadTask.result.form.parameters;

    if (!uploadUrl) throw new Error('No upload URL in task result');
    console.log('Upload URL:', uploadUrl);

    // STEP 2: Upload file
    const boundary = `Boundary${Date.now()}`;
    const CRLF = '\r\n';
    let formHeader = '';
    if (uploadParams) {
      for (const [k, v] of Object.entries(uploadParams)) {
        formHeader += `--${boundary}${CRLF}Content-Disposition: form-data; name="${k}"${CRLF}${CRLF}${v}${CRLF}`;
      }
    }
    formHeader += `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`;

    const multipart = Buffer.concat([
      Buffer.from(formHeader),
      fileBuffer,
      Buffer.from(`${CRLF}--${boundary}--${CRLF}`)
    ]);

    const uploadUrlObj = new URL(uploadUrl);
    const uploadRes = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: uploadUrlObj.hostname,
        path: uploadUrlObj.pathname + uploadUrlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': multipart.length
        }
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, text: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.write(multipart);
      req.end();
    });

    console.log('Upload status:', uploadRes.statusCode, uploadRes.text.substring(0, 150));

    // STEP 3: Wait for job
    const finishedJob = await waitForJob(jobId);

    // STEP 4: Get export URL
    const exportTask = finishedJob.tasks.find(t => t.name === 'export-file');
    if (!exportTask || !exportTask.result || !exportTask.result.files || !exportTask.result.files.length) {
      throw new Error('No exported files found');
    }

    const exportedFile = exportTask.result.files[0];
    console.log('Export file:', exportedFile.filename, 'URL:', exportedFile.url);

    // STEP 5: Download
    const fileData = await downloadFromUrl(exportedFile.url);
    console.log('Downloaded:', fileData.length, 'bytes');

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: fileData.toString('base64'),
        fileName: exportedFile.filename
      })
    };

  } catch (err) {
    console.error('Error:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message })
    };
  }
};
