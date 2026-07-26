// run-progressive-load-test.js
// ─────────────────────────────────────────────────────────────
// Runs a SERIES of load tests, ramping the target Virtual User count up
// step by step (30 -> 50 -> 75 -> 100 -> 150 -> 200 by default), without
// needing to re-run a command or re-answer questions for each step.
//
// This is a completely SEPARATE, ADDITIVE script — it does not modify
// run-load-test.js, generate-pdf-report.js, generate-html-report.js, or
// load-tests/load-test.js in any way, so nothing that already works can
// break. It reuses those same files as-is.
//
// Usage:
//     node run-progressive-load-test.js
// ─────────────────────────────────────────────────────────────

const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const MODULES_PATH = 'modules.json';
const PROGRESSIVE_DIR = 'reports/progressive';

const VU_STEPS = [30, 50, 75, 100, 150, 200];

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
    const choice = await askChoice('1) Which module do you want to test?', options);
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
    const secChoice = await askChoice(`   2) Which Section inside "${moduleName}"?`, secOptions);
    sectionName = secChoice === sectionNames.length ? await addNewSection(modules, moduleName) : sectionNames[secChoice];
  }

  const section = modules[moduleName].sections[sectionName];
  const subsectionNames = Object.keys(section.subsections);
  const subOptions = [...subsectionNames, '+ Add a new Subsection'];
  const subChoice = await askChoice(`      3) Which Subsection inside "${sectionName}"?`, subOptions);

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

  return {
    endpoint: mod.baseUrl.replace(/\/$/, '') + modules[moduleName].sections[sectionName].subsections[subsectionName],
    moduleName,
    sectionName,
    subsectionName,
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

function readSummaryMetrics() {
  try {
    const summary = JSON.parse(fs.readFileSync('reports/summary.json', 'utf-8'));
    const m = summary.metrics || {};
    const dur = (m.http_req_duration || {}).values || {};
    const failed = (m.http_req_failed || {}).values || {};
    const reqs = (m.http_reqs || {}).values || {};

    function thresholdPassed(name) {
      const t = m[name] && m[name].thresholds;
      if (!t) return null;
      return Object.values(t).every((x) => x.ok !== false);
    }
    const durPassed = thresholdPassed('http_req_duration');
    const errPassed = thresholdPassed('http_req_failed');
    const overallPass = durPassed !== false && errPassed !== false;

    return {
      avg: Math.round((dur.avg || 0) * 10) / 10,
      p95: Math.round((dur['p(95)'] || 0) * 10) / 10,
      errorRate: Math.round((failed.rate || 0) * 10000) / 100,
      totalRequests: reqs.count || 0,
      overallPass,
    };
  } catch (e) {
    return { avg: '-', p95: '-', errorRate: '-', totalRequests: '-', overallPass: null };
  }
}

function buildSummaryHtml(results) {
  const rows = results.map((r) => `
    <tr style="background:${r.overallPass ? '#E9F7EF' : '#FBEAEA'}">
      <td>${r.startVU} → ${r.targetVU}</td>
      <td>${r.avg} ms</td>
      <td>${r.p95} ms</td>
      <td>${r.errorRate}%</td>
      <td>${r.totalRequests}</td>
      <td style="font-weight:700;color:${r.overallPass ? '#2E9E4F' : '#D9534F'}">${r.overallPass ? 'PASS' : 'FAIL'}</td>
      <td><a href="progressive/${r.label}.html">dashboard</a> / <a href="progressive/${r.label}.pdf">pdf</a></td>
    </tr>`).join('');

  const firstFailIdx = results.findIndex((r) => r.overallPass === false);
  const verdict = firstFailIdx === -1
    ? `All tested VU levels (up to ${results[results.length - 1].targetVU}) passed. Consider testing even higher to find the true limit.`
    : `The server started failing at ${results[firstFailIdx].targetVU} concurrent users. The last known-good level was ${firstFailIdx > 0 ? results[firstFailIdx - 1].targetVU : 'below ' + results[0].startVU}.`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Progressive Load Test Summary</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background:#fff; color:#2B2B2B; padding:32px; }
  h1 { color:#005981; }
  table { width:100%; border-collapse: collapse; margin-top:16px; }
  th, td { padding:10px 12px; text-align:left; border-bottom:1px solid #eee; font-size:13px; }
  th { background:#F7F9FA; color:#2B2B2B; }
  .verdict { margin-top:20px; padding:16px; border-radius:8px; background:#F7F9FA; border:1px solid #E5E5E5; font-size:14px; }
</style></head>
<body>
  <h1>Progressive Load Test Summary</h1>
  <p style="color:#8A8A8A;">Generated ${new Date().toLocaleString()}</p>
  <table>
    <thead><tr><th>VU Ramp</th><th>Avg</th><th>p95</th><th>Error Rate</th><th>Total Requests</th><th>Result</th><th>Reports</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="verdict"><b>Verdict:</b> ${verdict}</div>
</body></html>`;
}

async function main() {
  console.log('\n📋  Progressive Load Test — answer these once, then it runs every step automatically\n');

  const { endpoint, moduleName, sectionName, subsectionName } = await pickEndpoint();
  console.log(`\n   → Endpoint selected: ${endpoint}\n`);

  const method = (await ask('HTTP Method (GET/POST/PUT/DELETE)', 'GET')).toUpperCase();
  let body = '{}';
  if (method === 'POST' || method === 'PUT') {
    body = await ask('Request Body (JSON string)', '{}');
  }
  const token = await ask('API Token (Bearer) - leave blank if none', '');
  const rampTime = await ask('Ramp-up duration for EACH step (e.g. 30s, 1m)', '30s');
  const maxResponseTime = await askNumber('Response time threshold in ms (X)', '500');
  const maxErrorRate = await askNumber('Error rate threshold in % (Y)', '1');

  rl.close();

  console.log(`\n🚀  Will run ${VU_STEPS.length} steps: ${VU_STEPS.join(' → ')}\n`);

  if (!fs.existsSync('reports')) fs.mkdirSync('reports');
  if (!fs.existsSync(PROGRESSIVE_DIR)) fs.mkdirSync(PROGRESSIVE_DIR, { recursive: true });

  const results = [];
  let previousTarget = Math.max(5, Math.round(VU_STEPS[0] / 3));

  for (let i = 0; i < VU_STEPS.length; i++) {
    const targetVU = VU_STEPS[i];
    const startVU = previousTarget;
    const label = `step-${i + 1}-${targetVU}VU`;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`STEP ${i + 1}/${VU_STEPS.length}: ${startVU} → ${targetVU} virtual users (ramp ${rampTime})`);
    console.log('='.repeat(60));

    const env = {
      ...process.env,
      ENDPOINT: endpoint, METHOD: method, BODY: body, API_TOKEN: token,
      START_VU: String(startVU), RAMP_TIME: rampTime, TARGET_VU: String(targetVU),
      MAX_RESPONSE_TIME: maxResponseTime, MAX_ERROR_RATE: maxErrorRate,
    };

    fs.writeFileSync(
      'reports/last-run-config.json',
      JSON.stringify({
        endpoint, moduleName, sectionName, subsectionName, method, body,
        startVU: String(startVU), rampTime, targetVU: String(targetVU),
        maxResponseTime, maxErrorRate,
      }, null, 2)
    );

    const k6Result = spawnSync('k6', ['run', 'load-tests/load-test.js'], { stdio: 'inherit', env });

    if (k6Result.error) {
      console.error(`\n❌  k6 failed to run: ${k6Result.error.message}`);
      break;
    }

    spawnSync('node', ['generate-pdf-report.js'], { stdio: 'inherit' });
    spawnSync('node', ['generate-html-report.js'], { stdio: 'inherit' });

    const metrics = readSummaryMetrics();
    results.push({ startVU, targetVU, label, ...metrics });

    try {
      if (fs.existsSync('reports/load-test-report.pdf')) {
        fs.copyFileSync('reports/load-test-report.pdf', `${PROGRESSIVE_DIR}/${label}.pdf`);
      }
      if (fs.existsSync('reports/load-test-dashboard.html')) {
        fs.copyFileSync('reports/load-test-dashboard.html', `${PROGRESSIVE_DIR}/${label}.html`);
      }
    } catch (e) {
      console.log(`   ⚠️  Could not archive this step's reports: ${e.message}`);
    }

    console.log(`\n   Result: ${metrics.overallPass ? '✅ PASS' : '❌ FAIL'}  |  avg ${metrics.avg}ms  |  p95 ${metrics.p95}ms  |  error rate ${metrics.errorRate}%`);

    previousTarget = targetVU;
  }

  const summaryHtml = buildSummaryHtml(results);
  const summaryPath = 'reports/progressive-summary.html';
  fs.writeFileSync(summaryPath, summaryHtml, 'utf-8');

  console.log(`\n\n📊  All steps complete. Summary saved to ${summaryPath}`);
  console.log('   Opening summary in browser...');
  openFile(summaryPath);

  setTimeout(() => process.exit(0), 1500);
}

main();
