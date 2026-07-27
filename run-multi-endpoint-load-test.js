// run-multi-endpoint-load-test.js
// ─────────────────────────────────────────────────────────────
// Runs a load test that hits SEVERAL different endpoints mixed together
// in the same test, instead of hammering just one — closer to how real
// users behave (they hit different APIs, not the same one repeatedly).
// Each endpoint can be given a relative "weight" to control how much of
// the traffic mix it gets (e.g. weight 3 = 3x more traffic than weight 1).
//
// This is a completely SEPARATE, ADDITIVE script — it does not modify
// run-load-test.js, run-progressive-load-test.js, or run-spike-load-test.js
// in any way, so nothing that already works can break. It reuses
// load-tests/load-test.js, generate-pdf-report.js, and generate-html-report.js
// as-is (load-test.js already supports an optional multi-endpoint mode).
//
// Note: all endpoints in the mix share ONE Bearer token and ONE response
// body validation rule (if enabled) for this first version. If your
// endpoints need different auth, save them under different modules and
// run them separately for now.
//
// Usage:
//     node run-multi-endpoint-load-test.js
// ─────────────────────────────────────────────────────────────

const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const MODULES_PATH = 'modules.json';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question, defaultVal) {
  return new Promise((resolve) => {
    const suffix = defaultVal ? ` (default: ${defaultVal})` : '';
    rl.question(`${question}${suffix}: `, (answer) => resolve(answer.trim() || defaultVal || ''));
  });
}

async function askNumber(question, defaultVal) {
  while (true) {
    const answer = await ask(question, defaultVal);
    const num = parseFloat(answer);
    if (!Number.isNaN(num) && num > 0) return answer;
    console.log(`   ⚠️  "${answer}" is not a valid number.`);
  }
}

async function askChoice(question, options) {
  console.log(`\n${question}`);
  options.forEach((opt, i) => console.log(`   ${i + 1}) ${opt}`));
  while (true) {
    const answer = await ask(`Enter a number (1-${options.length})`);
    const num = parseInt(answer, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= options.length) return num - 1;
    console.log(`   ⚠️  Please enter a number between 1 and ${options.length}.`);
  }
}

function loadModules() {
  if (!fs.existsSync(MODULES_PATH)) return {};
  let modules;
  try { modules = JSON.parse(fs.readFileSync(MODULES_PATH, 'utf-8')); }
  catch (e) { return {}; }
  let migrated = false;
  Object.keys(modules).forEach((modName) => {
    const mod = modules[modName];
    if (mod.endpoints && !mod.sections) {
      mod.sections = { General: { subsections: mod.endpoints } };
      delete mod.endpoints;
      migrated = true;
    }
    if (!mod.sections) mod.sections = {};
  });
  if (migrated) {
    console.log('   ℹ️  Upgraded modules.json to the new Module → Section → Subsection format (old endpoints moved under a "General" section).');
    saveModules(modules);
  }
  return modules;
}
function saveModules(modules) {
  fs.writeFileSync(MODULES_PATH, JSON.stringify(modules, null, 2), 'utf-8');
}

async function pickEndpoint() {
  const modules = loadModules();
  const moduleNames = Object.keys(modules);
  let moduleName;
  let moduleIsNew = false;
  if (moduleNames.length === 0) {
    console.log('\n📦  No modules saved yet — let\'s add your first one.');
    moduleName = await addNewModule(modules);
    moduleIsNew = true;
  } else {
    const options = [...moduleNames, '+ Add a new module'];
    const choice = await askChoice('Which module do you want to test?', options);
    if (choice === moduleNames.length) {
      moduleName = await addNewModule(modules);
      moduleIsNew = true;
    } else {
      moduleName = moduleNames[choice];
    }
  }

  const mod = modules[moduleName];

  if (!moduleIsNew) {
    console.log(`\n   Current Base URL: ${mod.baseUrl}`);
    const baseUrlChoice = await askChoice('   What do you want to do with this Base URL?', [
      'Use it as-is',
      'Edit it (change the Base URL for this module)',
    ]);
    if (baseUrlChoice === 1) {
      const newBaseUrl = await ask('   New Base URL');
      mod.baseUrl = newBaseUrl;
      saveModules(modules);
      console.log(`   ✓ Updated Base URL for "${moduleName}".`);
    }
  }
  const sectionNames = Object.keys(mod.sections);
  let sectionName;
  if (sectionNames.length === 0) {
    sectionName = await addNewSection(modules, moduleName);
  } else {
    const secOptions = [...sectionNames, '+ Add a new Section'];
    const secChoice = await askChoice(`   Which Section inside "${moduleName}"?`, secOptions);
    if (secChoice === sectionNames.length) {
      sectionName = await addNewSection(modules, moduleName);
    } else {
      sectionName = sectionNames[secChoice];
    }
  }

  const section = modules[moduleName].sections[sectionName];
  const subsectionNames = Object.keys(section.subsections);
  const subOptions = [...subsectionNames, '+ Add a new Subsection'];
  const subChoice = await askChoice(`      Which Subsection inside "${sectionName}"?`, subOptions);

  let subsectionName;
  if (subChoice === subsectionNames.length) {
    subsectionName = await addNewSubsection(modules, moduleName, sectionName);
  } else {
    subsectionName = subsectionNames[subChoice];
    const currentPath = modules[moduleName].sections[sectionName].subsections[subsectionName];
    const currentFull = mod.baseUrl.replace(/\/$/, '') + currentPath;
    console.log(`\n   Saved endpoint: ${currentFull}`);
    const keepOrEdit = await askChoice('   What do you want to do with this endpoint?', [
      'Use it as-is',
      'Edit it (update the saved API path)',
    ]);
    if (keepOrEdit === 1) {
      const newPathRaw = await ask('   New API path');
      const newPath = stripAccidentalHost(newPathRaw, mod.baseUrl);
      modules[moduleName].sections[sectionName].subsections[subsectionName] = newPath;
      saveModules(modules);
      console.log(`   ✓ Updated "${subsectionName}".`);
    }
  }

  const fullEndpoint = mod.baseUrl.replace(/\/$/, '') + modules[moduleName].sections[sectionName].subsections[subsectionName];
  return {
    endpoint: fullEndpoint,
    label: `${moduleName} › ${sectionName} › ${subsectionName}`,
  };
}

async function addNewModule(modules) {
  const moduleName = await ask('   New module name');
  const baseUrl = await ask('   Base URL for this module');
  modules[moduleName] = { baseUrl, sections: {} };
  await addNewSection(modules, moduleName);
  return moduleName;
}

async function addNewSection(modules, moduleName) {
  const sectionName = await ask('   New Section name');
  modules[moduleName].sections[sectionName] = { subsections: {} };
  await addNewSubsection(modules, moduleName, sectionName);
  return sectionName;
}

async function addNewSubsection(modules, moduleName, sectionName) {
  const subsectionName = await ask('   New Subsection name');
  let endpointPath = await ask('   API path');
  endpointPath = stripAccidentalHost(endpointPath, modules[moduleName].baseUrl);
  modules[moduleName].sections[sectionName].subsections[subsectionName] = endpointPath;
  saveModules(modules);
  console.log(`   ✓ Saved "${subsectionName}" under Section "${sectionName}" (Module "${moduleName}") — it'll show up as a choice next time.`);
  return subsectionName;
}

function stripAccidentalHost(inputPath, baseUrl) {
  if (!/^https?:\/\//i.test(inputPath)) return inputPath;
  const base = (baseUrl || '').replace(/\/$/, '');
  if (base && inputPath.startsWith(base)) {
    const stripped = inputPath.slice(base.length);
    console.log(`   ⚠️  Detected the module's Base URL inside the API path — removed it so the URL isn't duplicated. Saved path: ${stripped}`);
    return stripped;
  }
  try {
    const url = new URL(inputPath);
    console.log(`   ⚠️  Detected a full URL in the API path — keeping only the path/query part so it isn't combined with the Base URL twice. Saved path: ${url.pathname}${url.search}`);
    return `${url.pathname}${url.search}`;
  } catch (e) {
    return inputPath;
  }
}

const CHROME_PATHS_WIN = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];
function findChromeWin() { return CHROME_PATHS_WIN.find((p) => p && fs.existsSync(p)); }

function openFile(filePath) {
  const platform = process.platform;
  const absPath = path.resolve(filePath);
  let cmd, args;
  if (platform === 'win32') {
    const chromePath = findChromeWin();
    cmd = chromePath || 'explorer';
    args = [absPath];
  } else if (platform === 'darwin') {
    cmd = 'open'; args = ['-a', 'Google Chrome', absPath];
  } else {
    cmd = 'google-chrome'; args = [absPath];
  }
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

async function main() {
  console.log('\n🔀  Multi-Endpoint Load Test — mix several endpoints into one test\n');

  const endpoints = [];
  let addMore = true;
  while (addMore) {
    console.log(`\n${'-'.repeat(60)}`);
    console.log(`Endpoint #${endpoints.length + 1}`);
    console.log('-'.repeat(60));

    const { endpoint, label } = await pickEndpoint();
    const method = (await ask('   HTTP Method (GET/POST/PUT/DELETE)', 'GET')).toUpperCase();
    let body = '{}';
    if (method === 'POST' || method === 'PUT') {
      body = await ask('   Request Body (JSON string)', '{}');
    }
    const weight = await askNumber('   Relative traffic weight (1 = normal, 3 = 3x more traffic than a weight-1 endpoint)', '1');

    endpoints.push({ label, url: endpoint, method, body, weight: Number(weight) });
    console.log(`   ✓ Added "${label}" (weight ${weight})`);

    if (endpoints.length >= 2) {
      const more = await askChoice('Add another endpoint to the mix?', ['No, that\'s all', 'Yes, add another']);
      addMore = more === 1;
    }
  }

  console.log(`\n📋  ${endpoints.length} endpoints in the mix:`);
  endpoints.forEach((e, i) => console.log(`   ${i + 1}. [weight ${e.weight}] ${e.method} ${e.url}`));

  const token = await ask('\nAPI Token (Bearer) - shared across all endpoints above, leave blank if none', '');
  const startVU = await askNumber('Starting number of Virtual Users (N)', '10');
  const rampTime = await ask('Ramp-up duration (e.g. 30s, 2m)', '30s');
  const targetVU = await askNumber('Maximum Virtual Users to ramp up to (M)', '50');
  const maxResponseTime = await askNumber('Response time threshold in ms (X)', '500');
  const maxErrorRate = await askNumber('Error rate threshold in % (Y)', '1');

  const wantsValidation = await askChoice('Validate response body content for ALL endpoints above (same rule applied to each)?', [
    'No, skip this',
    'Yes, check a field in the response body',
  ]);

  let validateEnabled = false;
  let validateField = '';
  let validateMode = 'exists';
  let validateValue = '';

  if (wantsValidation === 1) {
    validateEnabled = true;
    validateField = await ask('   Field to check (dot notation, e.g. "value" or "data.items")');
    const modeChoice = await askChoice('   What should this field satisfy?', [
      'Must exist (not null/undefined)',
      'Must be a non-empty array',
      'Must equal a specific value',
    ]);
    validateMode = modeChoice === 1 ? 'array' : modeChoice === 2 ? 'equals' : 'exists';
    if (modeChoice === 2) {
      validateValue = await ask('   Expected value (compared as text)');
    }
  }

  rl.close();

  console.log('\n🚀  Configuration complete. Starting mixed-endpoint load test...\n');
  console.log(`   VU       : ${startVU} -> ${targetVU} (ramp: ${rampTime})`);
  console.log(`   Threshold: p95 < ${maxResponseTime}ms, error rate < ${maxErrorRate}%\n`);

  if (!fs.existsSync('reports')) fs.mkdirSync('reports');

  fs.writeFileSync(
    'reports/last-run-config.json',
    JSON.stringify({
      testType: 'multi',
      endpoints,
      endpoint: `${endpoints.length} endpoints (mixed traffic)`,
      method: 'MIXED',
      startVU, rampTime, targetVU,
      maxResponseTime, maxErrorRate, validateEnabled, validateField, validateMode, validateValue,
    }, null, 2)
  );

  const env = {
    ...process.env,
    ENDPOINTS: JSON.stringify(endpoints), API_TOKEN: token,
    START_VU: startVU, RAMP_TIME: rampTime, TARGET_VU: targetVU,
    MAX_RESPONSE_TIME: maxResponseTime, MAX_ERROR_RATE: maxErrorRate,
    VALIDATE_ENABLED: String(validateEnabled), VALIDATE_FIELD: validateField,
    VALIDATE_MODE: validateMode, VALIDATE_VALUE: validateValue,
  };

  const k6 = spawn('k6', ['run', 'load-tests/load-test.js'], { stdio: 'inherit', env });

  k6.on('error', (err) => {
    console.error('\n❌  Failed to run k6. Check whether k6 is installed (run: k6 version).');
    console.error(err.message);
    process.exit(1);
  });

  k6.on('close', (code) => {
    console.log('\n📊  Building dashboard...');
    const htmlResult = spawnSync('node', ['generate-html-report.js'], { stdio: 'inherit' });
    const pdfResult = spawnSync('node', ['generate-pdf-report.js'], { stdio: 'inherit' });

    const htmlPath = 'reports/load-test-dashboard.html';
    if (htmlResult.status === 0 && fs.existsSync(htmlPath)) {
      console.log('🌐  Opening dashboard in browser...');
      openFile(htmlPath);
    } else {
      console.log('⚠️  Could not generate the HTML dashboard - check the errors above.');
    }

    const pdfPath = 'reports/load-test-report.pdf';
    if (pdfResult.status === 0 && fs.existsSync(pdfPath)) {
      console.log('📄  Opening PDF report...');
      openFile(pdfPath);
    } else {
      console.log('⚠️  Could not generate the PDF report - check the errors above.');
    }

    setTimeout(() => process.exit(code), 1500);
  });
}

main();
