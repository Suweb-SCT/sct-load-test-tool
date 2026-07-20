const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question, defaultVal) {
  return new Promise((resolve) => {
    const suffix = defaultVal ? ` (default: ${defaultVal})` : '';
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

// Keeps asking until the answer is a valid positive number.
// Prevents bugs like typing "y" for a numeric field (which silently breaks k6 thresholds).
async function askNumber(question, defaultVal) {
  while (true) {
    const answer = await ask(question, defaultVal);
    const num = parseFloat(answer);
    if (!Number.isNaN(num) && num > 0) return answer;
    console.log(`   \u26A0\uFE0F  "${answer}" is not a valid number. Please enter a number (e.g. 10, 500, 1.5).`);
  }
}

// Opens a file with the OS default app (PDF viewer / browser)
function openFile(filePath) {
  const platform = process.platform;
  const absPath = path.resolve(filePath);

  let cmd;
  let args;
  if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', absPath];
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = [absPath];
  } else {
    cmd = 'xdg-open';
    args = [absPath];
  }

  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

async function main() {
  console.log('\n\u{1F4CB}  Load Test Configuration - please answer the following questions\n');

  const endpoint = await ask('1) API Endpoint URL', 'https://your-api.com/api/equipments');
  const method = (await ask('2) HTTP Method (GET/POST/PUT/DELETE)', 'GET')).toUpperCase();

  let body = '{}';
  if (method === 'POST' || method === 'PUT') {
    body = await ask('   Request Body (enter as a JSON string)', '{}');
  }

  const token = await ask('3) API Token (Bearer) - leave blank and press Enter if none', '');
  const startVU = await askNumber('4) Starting number of Virtual Users (N)', '10');
  const rampTime = await ask('5) Ramp-up duration (e.g. 30s, 2m)', '30s');
  const targetVU = await askNumber('6) Maximum Virtual Users to ramp up to (M)', '50');
  const maxResponseTime = await askNumber('7) Response time threshold in ms (X)', '500');
  const maxErrorRate = await askNumber('8) Error rate threshold in % (Y)', '1');

  rl.close();

  console.log('\n\u{1F680}  Configuration complete. Starting k6 load test...\n');
  console.log(`   Endpoint : ${method} ${endpoint}`);
  console.log(`   VU       : ${startVU} -> ${targetVU} (ramp: ${rampTime})`);
  console.log(`   Threshold: p95 < ${maxResponseTime}ms, error rate < ${maxErrorRate}%\n`);

  if (!fs.existsSync('reports')) fs.mkdirSync('reports');

  fs.writeFileSync(
    'reports/last-run-config.json',
    JSON.stringify(
      { endpoint, method, body, startVU, rampTime, targetVU, maxResponseTime, maxErrorRate },
      null,
      2
    )
  );

  const env = {
    ...process.env,
    ENDPOINT: endpoint,
    METHOD: method,
    BODY: body,
    API_TOKEN: token,
    START_VU: startVU,
    RAMP_TIME: rampTime,
    TARGET_VU: targetVU,
    MAX_RESPONSE_TIME: maxResponseTime,
    MAX_ERROR_RATE: maxErrorRate,
  };

  const k6 = spawn('k6', ['run', 'load-tests/load-test.js'], {
    stdio: 'inherit',
    env,
  });

  k6.on('error', (err) => {
    console.error('\n\u274C  Failed to run k6. Check whether k6 is installed (run: k6 version).');
    console.error(err.message);
    process.exit(1);
  });

  k6.on('close', (code) => {
    console.log('\n\u{1F4C4}  Building PDF report...');
    const result = spawnSync('node', ['generate-pdf-report.js'], { stdio: 'inherit' });

    const reportPath = 'reports/load-test-report.pdf';
    if (result.status === 0 && fs.existsSync(reportPath)) {
      console.log('\u{1F4CA}  Opening PDF report...');
      openFile(reportPath);
    } else {
      console.log('\u26A0\uFE0F  Could not generate the PDF report - check the errors above.');
    }
    process.exit(code);
  });
}

main();
