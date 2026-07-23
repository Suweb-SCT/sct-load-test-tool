const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const MODULES_PATH = 'modules.json';

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

async function askNumber(question, defaultVal) {
  while (true) {
    const answer = await ask(question, defaultVal);
    const num = parseFloat(answer);
    if (!Number.isNaN(num) && num > 0) return answer;
    console.log(`   \u26A0\uFE0F  "${answer}" is not a valid number. Please enter a number (e.g. 10, 500, 1.5).`);
  }
}

async function askChoice(question, options) {
  console.log(`\n${question}`);
  options.forEach((opt, i) => console.log(`   ${i + 1}) ${opt}`));
  while (true) {
    const answer = await ask(`Enter a number (1-${options.length})`);
    const num = parseInt(answer, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= options.length) return num - 1;
    console.log(`   \u26A0\uFE0F  Please enter a number between 1 and ${options.length}.`);
  }
}

function loadModules() {
  if (!fs.existsSync(MODULES_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(MODULES_PATH, 'utf-8'));
  } catch (e) {
    console.log('   \u26A0\uFE0F  modules.json is corrupted or unreadable, starting fresh.');
    return {};
  }
}

function saveModules(modules) {
  fs.writeFileSync(MODULES_PATH, JSON.stringify(modules, null, 2), 'utf-8');
}

async function pickEndpoint() {
  const modules = loadModules();
  const moduleNames = Object.keys(modules);

  let moduleName;
  if (moduleNames.length === 0) {
    console.log('\n\u{1F4E6}  No modules saved yet — let\'s add your first one.');
    moduleName = await addNewModule(modules);
  } else {
    const options = [...moduleNames, '+ Add a new module'];
    const choice = await askChoice('1) Which module do you want to test?', options);
    if (choice === moduleNames.length) {
      moduleName = await addNewModule(modules);
    } else {
      moduleName = moduleNames[choice];
    }
  }

  const mod = modules[moduleName];
  const subsectionNames = Object.keys(mod.endpoints);
  const subOptions = [...subsectionNames, '+ Add a new API/subsection to this module'];
  const subChoice = await askChoice(`   Which API/subsection inside "${moduleName}"?`, subOptions);

  let subsectionName;
  if (subChoice === subsectionNames.length) {
    subsectionName = await addNewSubsection(modules, moduleName);
  } else {
    subsectionName = subsectionNames[subChoice];
  }

  const fullEndpoint = mod.baseUrl.replace(/\/$/, '') + modules[moduleName].endpoints[subsectionName];
  return fullEndpoint;
}

async function addNewModule(modules) {
  const moduleName = await ask('   New module name');
  const baseUrl = await ask('   Base URL for this module');
  modules[moduleName] = { baseUrl, endpoints: {} };
  const subsectionName = await addNewSubsection(modules, moduleName);
  return moduleName;
}

async function addNewSubsection(modules, moduleName) {
  const subsectionName = await ask('   New API/subsection name');
  const endpointPath = await ask('   API path');
  modules[moduleName].endpoints[subsectionName] = endpointPath;
  saveModules(modules);
  console.log(`   \u2713 Saved "${subsectionName}" under module "${moduleName}" — it'll show up as a choice next time.`);
  return subsectionName;
}

// Windows: try to launch Google Chrome directly (Chrome can display both
// .html and .pdf files). Falls back to explorer.exe (default app) if Chrome
// isn't found at any of the usual install locations.
const CHROME_PATHS_WIN = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

function findChromeWin() {
  return CHROME_PATHS_WIN.find((p) => p && fs.existsSync(p));
}

function openFile(filePath) {
  const platform = process.platform;
  const absPath = path.resolve(filePath);
  let cmd, args;

  if (platform === 'win32') {
    const chromePath = findChromeWin();
    if (chromePath) {
      cmd = chromePath;
      args = [absPath];
    } else {
      console.log('   \u26A0\uFE0F  Google Chrome not found at the usual install paths — falling back to the default app.');
      cmd = 'explorer';
      args = [absPath];
    }
  } else if (platform === 'darwin') {
    cmd = 'open'; args = ['-a', 'Google Chrome', absPath];
  } else {
    cmd = 'google-chrome'; args = [absPath];
  }

  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', (err) => {
    console.log(`   \u26A0\uFE0F  Could not auto-open ${absPath}: ${err.message}`);
    console.log('      Open it manually by double-clicking the file in File Explorer.');
  });
  child.unref();
}

async function main() {
  console.log('\n\u{1F4CB}  Load Test Configuration - please answer the following questions\n');

  const endpoint = await pickEndpoint();
  console.log(`\n   \u2192 Endpoint selected: ${endpoint}\n`);

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
    JSON.stringify({ endpoint, method, body, startVU, rampTime, targetVU, maxResponseTime, maxErrorRate }, null, 2)
  );

  const env = {
    ...process.env,
    ENDPOINT: endpoint, METHOD: method, BODY: body, API_TOKEN: token,
    START_VU: startVU, RAMP_TIME: rampTime, TARGET_VU: targetVU,
    MAX_RESPONSE_TIME: maxResponseTime, MAX_ERROR_RATE: maxErrorRate,
  };

  const k6 = spawn('k6', ['run', 'load-tests/load-test.js'], { stdio: 'inherit', env });

  k6.on('error', (err) => {
    console.error('\n\u274C  Failed to run k6. Check whether k6 is installed (run: k6 version).');
    console.error(err.message);
    process.exit(1);
  });

  k6.on('close', (code) => {
    console.log('\n\u{1F4CA}  Building dashboard...');
    const htmlResult = spawnSync('node', ['generate-html-report.js'], { stdio: 'inherit' });
    const pdfResult = spawnSync('node', ['generate-pdf-report.js'], { stdio: 'inherit' });

    const htmlPath = 'reports/load-test-dashboard.html';
    if (htmlResult.status === 0 && fs.existsSync(htmlPath)) {
      console.log('\u{1F310}  Opening dashboard in browser...');
      openFile(htmlPath);
    } else {
      console.log('\u26A0\uFE0F  Could not generate the HTML dashboard - check the errors above.');
    }

    const pdfPath = 'reports/load-test-report.pdf';
    if (pdfResult.status === 0 && fs.existsSync(pdfPath)) {
      console.log('\u{1F4C4}  Opening PDF report...');
      openFile(pdfPath);
    } else {
      console.log('\u26A0\uFE0F  Could not generate the PDF report - check the errors above.');
    }

    process.exit(code);
  });
}

main();
