// test-kimi.js
const https = require('https');

function testEndpoint(path, label) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.kimi.com',
      path: path,
      method: 'GET',
      headers: {
        'x-api-key': 'sk-kimi-4tj4JFjEz5Y3pItrTVCdfZiTRnU0WZDqjgdJo1DHg7Svlm9QOoPVb77RMOWdRvYw',
        'anthropic-version': '2023-06-01',
        'User-Agent': 'Claude-Code/1.0.0',
        'Content-Type': 'application/json'
      }
    };
    
    console.log(`[${label}] Testing ${path}...`);
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { 
        console.log(`[${label}] STATUS: ${res.statusCode}`);
        console.log(`[${label}] BODY:`, data.substring(0, 500) + (data.length > 500 ? '...' : ''));
        resolve();
      });
    });
    req.on('error', (e) => { 
      console.error(`[${label}] ERROR:`, e.message); 
      resolve();
    });
    req.end();
  });
}

async function run() {
  await testEndpoint('/coding/models', 'Endpoint 1');
  await testEndpoint('/v1/models', 'Endpoint 2');
}

run();
