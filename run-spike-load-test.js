// run-spike-load-test.js
// ─────────────────────────────────────────────────────────────
// Runs a SPIKE test: normal (baseline) traffic, then a sudden, sharp
// jump to a much higher number of Virtual Users, held for a while, then
// a cool-down back to zero. This is different from the progressive test
// (which climbs gradually step by step) — a spike simulates a real-world
// traffic burst (e.g. a flash sale, a viral link, a scheduled batch job)
// hitting the API all at once.
//
// This is a completely SEPARATE, ADDITIVE script — it does not modify
// run-load-test.js or run-progressive-load-test.js in any way, so nothing
// that already works can break. It reuses load-tests/load-test.js,
// generate-pdf-report.js, and generate-html-report.js as-is.
//
// Usage:
//     node run-spike-load-test.js
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

  if (moduleNames.length > 0) {
    const firstModuleName = moduleNames[0];
    const firstMod = modules[firstModuleName];
    console.log(`\n   Current Base URL: ${firstMod.baseUrl}`);
    const baseUrlChoice = await askChoice('   What do you want to do with this Base URL?', [
      'Use it as-is',
      'Edit it (change the Base URL for this module)',
    ]);
    if (baseUrlChoice === 1) {
      const newBaseUrl = await ask('   New Base URL');
      firstMod.baseUrl = newBaseUrl;
      saveModules(modules);
      console.log(`   ✓ Updated Base URL for "${firstModuleName}".`);
    }
  }

  let moduleName;
  let moduleIsNew = false;
  if (moduleNames.length === 0) {
    console.log('\n📦  No modules saved yet — let\'s add your first one.');
    moduleName = await addNewModule(modules);
    moduleIsNew = true;
  } else {
    const options = [...moduleNames, '+ Add a new module'];
    const choice = await askChoice('1) Which module do you want to test?', options);
    if (choice === moduleNames.length) {
      moduleName = await addNewModule(modules);
      moduleIsNew = true;
    } else {
      moduleName = moduleNames[choice];
    }
  }

  const mod = modules[moduleName];
  const sectionNames = Object.keys(mod.sections);
  const SKIP_LABEL = 'Skip — use this Module directly (no Section)';
  const secOptions = [...sectionNames, SKIP_LABEL, '+ Add a new Section'];
  const secChoice = await askChoice(`   2) Which Section inside "${moduleName}"?`, secOptions);

  let sectionName = null;
  let subsectionName = null;
  let endpointPath;

  if (secChoice === sectionNames.length) {
    // Skip chosen — the Module itself carries a direct path, no Section
    // (and therefore no Subsection) needed.
    if (mod.directPath) {
      const currentFull = mod.baseUrl.replace(/\/$/, '') + mod.directPath;
      console.log(`\n   Saved endpoint: ${currentFull}`);
      const keepOrEdit = await askChoice('   What do you want to do with this endpoint?', [
        'Use it as-is',
        'Edit it (update the saved API path)',
      ]);
      if (keepOrEdit === 1) {
        const newPathRaw = await ask('   New API path');
        mod.directPath = stripAccidentalHost(newPathRaw, mod.baseUrl);
        saveModules(modules);
        console.log(`   ✓ Updated direct path for Module "${moduleName}".`);
      }
    } else {
      const newPathRaw = await ask('   API path for this Module');
      mod.directPath = stripAccidentalHost(newPathRaw, mod.baseUrl);
      saveModules(modules);
      console.log(`   ✓ Saved direct path for Module "${moduleName}".`);
    }
    endpointPath = mod.directPath;
  } else if (secChoice === sectionNames.length + 1) {
    const created = await addNewSection(modules, moduleName);
    sectionName = created.sectionName;
    subsectionName = created.subsectionName;
    endpointPath = modules[moduleName].sections[sectionName].subsections[subsectionName];
  } else {
    sectionName = sectionNames[secChoice];
    const section = modules[moduleName].sections[sectionName];
    const subsectionNames = Object.keys(section.subsections);
    const subOptions = [...subsectionNames, '+ Add a new Subsection'];
    const subChoice = await askChoice(`      3) Which Subsection inside "${sectionName}"?`, subOptions);

    if (subChoice === subsectionNames.length) {
      subsectionName = await addNewSubsection(modules, moduleName, sectionName);
      endpointPath = modules[moduleName].sections[sectionName].subsections[subsectionName];
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
      endpointPath = modules[moduleName].sections[sectionName].subsections[subsectionName];
    }
  }

  const fullEndpoint = mod.baseUrl.replace(/\/$/, '') + endpointPath;
  return { endpoint: fullEndpoint, moduleName, sectionName, subsectionName };
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
  const subsectionName = await addNewSubsection(modules, moduleName, sectionName);
  return { sectionName, subsectionName };
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
  console.log('\n⚡  Spike Load Test — sudden traffic burst, then measure recovery\n');

  const { endpoint, moduleName, sectionName, subsectionName } = await pickEndpoint();
  console.log(`\n   → Endpoint selected: ${endpoint}\n`);

  const method = (await ask('HTTP Method (GET/POST/PUT/DELETE)', 'GET')).toUpperCase();
  let body = '{}';
  if (method === 'POST' || method === 'PUT') {
    body = await ask('Request Body (JSON string)', '{}');
  }
  const token = await ask('API Token (Bearer) - leave blank if none', '');

  const baselineVU = await askNumber('Baseline Virtual Users (normal traffic level, before/after the spike)', '10');
  const spikeVU = await askNumber('Spike Virtual Users (the sudden peak)', '200');
  const spikeRampTime = await ask('How fast should the spike hit? (e.g. 5s for near-instant, 30s for a fast ramp)', '5s');
  const spikeHold = await ask('How long should traffic stay at the peak?', '1m');
  const recoveryTime = await ask('Cool-down time after the spike (ramping back to 0)', '30s');

  const maxResponseTime = await askNumber('Response time threshold in ms (X)', '500');
  const maxErrorRate = await askNumber('Error rate threshold in % (Y)', '1');

  const wantsValidation = await askChoice('Do you want to validate the response body content (not just status code)?', [
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

  console.log('\n🚀  Configuration complete. Starting spike test...\n');
  console.log(`   Endpoint : ${method} ${endpoint}`);
  console.log(`   Profile  : ${baselineVU} baseline → ${spikeVU} spike (jump in ${spikeRampTime}, hold ${spikeHold}, recover ${recoveryTime})`);
  console.log(`   Threshold: p95 < ${maxResponseTime}ms, error rate < ${maxErrorRate}%\n`);

  if (!fs.existsSync('reports')) fs.mkdirSync('reports');

  fs.writeFileSync(
    'reports/last-run-config.json',
    JSON.stringify({
      endpoint, moduleName, sectionName, subsectionName, method, body,
      testType: 'spike',
      startVU: baselineVU, rampTime: spikeRampTime, targetVU: spikeVU,
      spikeHold, recoveryTime,
      maxResponseTime, maxErrorRate, validateEnabled, validateField, validateMode, validateValue,
    }, null, 2)
  );

  const env = {
    ...process.env,
    ENDPOINT: endpoint, METHOD: method, BODY: body, API_TOKEN: token,
    START_VU: baselineVU, RAMP_TIME: spikeRampTime, TARGET_VU: spikeVU,
    SPIKE_HOLD: spikeHold, RECOVERY_TIME: recoveryTime,
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
