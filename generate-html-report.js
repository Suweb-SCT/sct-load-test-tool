const fs = require('fs');

const SUMMARY_PATH = 'reports/summary.json';
const CONFIG_PATH = 'reports/last-run-config.json';
const OUTPUT_PATH = 'reports/load-test-dashboard.html';

if (!fs.existsSync(SUMMARY_PATH)) {
  console.error('Error: reports/summary.json not found - did the k6 run finish successfully?');
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf-8'));
const config = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  : {};

const LOGO_PATH = 'logo.png';
let logoDataUri = '';
if (fs.existsSync(LOGO_PATH)) {
  const logoBase64 = fs.readFileSync(LOGO_PATH).toString('base64');
  logoDataUri = `data:image/png;base64,${logoBase64}`;
}

const metrics = summary.metrics || {};
function getValues(name) {
  return metrics[name] ? metrics[name].values : null;
}

function thresholdInfo(name) {
  const m = metrics[name];
  if (!m || !m.thresholds) return { passed: null, expressions: [] };
  const expressions = Object.keys(m.thresholds);
  const passed = Object.values(m.thresholds).every((t) => t.ok !== false);
  return { passed, expressions };
}

const reqDuration = getValues('http_req_duration') || {};
const reqFailed = getValues('http_req_failed') || {};
const reqs = getValues('http_reqs') || {};
const checksAgg = getValues('checks') || {};

const durationInfo = thresholdInfo('http_req_duration');
const errorInfo = thresholdInfo('http_req_failed');
const overallPass = durationInfo.passed !== false && errorInfo.passed !== false;

function collectChecks(group, acc) {
  if (!group) return acc;
  (group.checks || []).forEach((c) => acc.push(c));
  (group.groups ? Object.values(group.groups) : []).forEach((g) => collectChecks(g, acc));
  return acc;
}
const checksList = collectChecks(summary.root_group, []);

const thresholdMs = parseFloat((durationInfo.expressions[0] || '').match(/<\s*([\d.]+)/)?.[1]) || null;
const checksPassRate = Math.round((checksAgg.rate || 0) * 100);
const errorRatePct = Math.round((reqFailed.rate || 0) * 10000) / 100;

const data = {
  overallPass,
  endpoint: `${config.method || '-'} ${config.endpoint || '-'}`,
  vu: `${config.startVU || '-'} \u2192 ${config.targetVU || '-'} (ramp ${config.rampTime || '-'})`,
  thresholdMs,
  maxErrorRate: config.maxErrorRate || '-',
  totalRequests: reqs.count || 0,
  rps: Math.round((reqs.rate || 0) * 100) / 100,
  avg: Math.round((reqDuration.avg || 0) * 10) / 10,
  min: Math.round((reqDuration.min || 0) * 10) / 10,
  med: Math.round((reqDuration.med || 0) * 10) / 10,
  max: Math.round((reqDuration.max || 0) * 10) / 10,
  p90: Math.round((reqDuration['p(90)'] || 0) * 10) / 10,
  p95: Math.round((reqDuration['p(95)'] || 0) * 10) / 10,
  checksPassRate,
  errorRatePct,
  durationPassed: durationInfo.passed,
  errorPassed: errorInfo.passed,
  checks: checksList.map((c) => ({ name: c.name, passes: c.passes || 0, fails: c.fails || 0 })),
  generatedAt: new Date().toLocaleString(),
};

function svgGauge(value, color) {
  const clamped = Math.max(0, Math.min(100, value));
  const r = 70, cx = 90, cy = 85;
  const endAngle = Math.PI + (Math.PI * clamped / 100);
  const arcX = cx + r * Math.cos(endAngle);
  const arcY = cy + r * Math.sin(endAngle);
  const largeArc = clamped > 50 ? 1 : 0;
  const bgPath = `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy}`;
  const valPath = `M ${cx - r} ${cy} A ${r} ${r} 0 ${largeArc} 1 ${arcX} ${arcY}`;
  return `<svg viewBox="0 0 180 100" width="180" height="100">
    <path d="${bgPath}" fill="none" stroke="#E8E8E8" stroke-width="16" stroke-linecap="round"/>
    <path d="${valPath}" fill="none" stroke="${color}" stroke-width="16" stroke-linecap="round"/>
  </svg>`;
}

function svgBarChart(bars, thresholdValue) {
  const width = 560, height = 200, padBottom = 26, padTop = 20, gap = 40, barWidth = 60;
  const maxVal = Math.max(...bars.map((b) => b.value), thresholdValue || 0, 1) * 1.15;
  const chartHeight = height - padBottom - padTop;
  const startX = 50;
  const chartRight = startX + bars.length * (barWidth + gap) - gap + barWidth;

  const barsSvg = bars.map((b, i) => {
    const x = startX + i * (barWidth + gap);
    const barH = (b.value / maxVal) * chartHeight;
    const y = padTop + (chartHeight - barH);
    return `
      <rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${b.color}" rx="4"/>
      <text x="${x + barWidth / 2}" y="${y - 8}" text-anchor="middle" font-size="12" fill="#2B2B2B" font-weight="600">${b.value}ms</text>
      <text x="${x + barWidth / 2}" y="${height - 6}" text-anchor="middle" font-size="12" font-weight="600" fill="#2B2B2B">${b.label}</text>`;
  }).join('');

  let thresholdSvg = '';
  if (thresholdValue) {
    const ty = padTop + (chartHeight - (thresholdValue / maxVal) * chartHeight);
    thresholdSvg = `<line x1="${startX - 15}" y1="${ty}" x2="${chartRight}" y2="${ty}" stroke="#2B2B2B" stroke-width="1.5" stroke-dasharray="5,4"/>`;
  }

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="220" style="max-width:640px">${barsSvg}${thresholdSvg}</svg>`;
}

const checksGaugeColor = data.checksPassRate >= 90 ? '#2E9E4F' : data.checksPassRate >= 50 ? '#E8A33D' : '#D9534F';
const errorGaugeColor = data.errorPassed === false ? '#D9534F' : '#2E9E4F';

const barChartSvg = svgBarChart([
  { label: 'avg', value: data.avg, color: '#3D9BE8' },
  { label: 'p90', value: data.p90, color: '#E8A33D' },
  { label: 'p95', value: data.p95, color: '#D9534F' },
  { label: 'max', value: data.max, color: '#8A8A8A' },
], data.thresholdMs);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>API Load Test Dashboard</title>
<style>
  :root {
    --orange: #FFA600; --blue: #005981; --green: #2E9E4F; --red: #D9534F;
    --dark: #2B2B2B; --gray: #8A8A8A; --bg: #FFFFFF; --card-bg: #FFFFFF; --card-border: #E5E5E5; --panel-bg: #F7F9FA;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--dark); padding: 32px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
  .header-right { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
  .logo { height: 34px; }
  h1 { margin: 0; font-size: 26px; color: var(--blue); }
  .subtitle { color: var(--gray); font-size: 13px; margin-top: 4px; }
  .status-badge { padding: 8px 18px; border-radius: 20px; font-weight: 700; font-size: 14px; color: white; white-space: nowrap; }
  .status-badge.pass { background: var(--green); }
  .status-badge.fail { background: var(--red); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-bottom: 20px; align-items: start; }
  .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); overflow: hidden; min-width: 0; }
  .card h3 { margin: 0 0 12px 0; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dark); }
  .gauge-wrap { position: relative; height: 100px; display: flex; justify-content: center; }
  .gauge-value { position: absolute; top: 60px; left: 50%; transform: translateX(-50%); font-size: 26px; font-weight: 700; }
  .gauge-label { text-align: center; margin-top: 20px; font-size: 13px; color: var(--dark); }
  .kpi-row { display: flex; gap: 12px; }
  .kpi-box { flex: 1; text-align: center; padding: 12px 8px; border-radius: 8px; background: var(--panel-bg); min-width: 0; }
  .kpi-box .num { font-size: 22px; font-weight: 700; }
  .kpi-box .lbl { font-size: 11px; color: var(--dark); margin-top: 2px; }
  .wide-card { grid-column: 1 / -1; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; background: var(--panel-bg); color: var(--dark); font-weight: 600; }
  td { padding: 8px 10px; border-bottom: 1px solid #EEE; }
  .pass-text { color: var(--green); font-weight: 600; }
  .fail-text { color: var(--red); font-weight: 600; }
  .rec-list { margin: 0; padding-left: 18px; font-size: 13.5px; line-height: 1.6; }
  .config-row { font-size: 13px; margin-bottom: 8px; }
  .config-row b { color: var(--dark); display: block; margin-bottom: 3px; }
  .endpoint-box {
    font-family: "SF Mono", Consolas, monospace;
    font-size: 11.5px;
    background: var(--panel-bg);
    padding: 8px 10px;
    border-radius: 6px;
    overflow-wrap: anywhere;
    word-break: break-all;
    max-height: 90px;
    overflow-y: auto;
    line-height: 1.5;
  }
  .chart-legend { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dark); margin-bottom: 4px; }
  .chart-legend .dash-line { width: 20px; height: 0; border-top: 2px dashed var(--dark); display: inline-block; }
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>API Load Test Dashboard</h1>
    <div class="subtitle">Generated ${data.generatedAt}</div>
  </div>
  <div class="header-right">
    ${logoDataUri ? `<img class="logo" src="${logoDataUri}" alt="Company logo">` : ''}
    <div class="status-badge ${data.overallPass ? 'pass' : 'fail'}">${data.overallPass ? '\u2713 PASS' : '\u2717 FAIL'}</div>
  </div>
</div>

<div class="grid">
  <div class="card">
    <h3>Checks Passed</h3>
    <div class="gauge-wrap">${svgGauge(data.checksPassRate, checksGaugeColor)}<div class="gauge-value">${data.checksPassRate}%</div></div>
    <div class="gauge-label">Overall check pass rate</div>
  </div>

  <div class="card">
    <h3>Error Rate</h3>
    <div class="gauge-wrap">${svgGauge(Math.min(data.errorRatePct, 100), errorGaugeColor)}<div class="gauge-value">${data.errorRatePct}%</div></div>
    <div class="gauge-label">Threshold: &lt; ${data.maxErrorRate}%</div>
  </div>

  <div class="card">
    <h3>Requests</h3>
    <div class="kpi-row" style="margin-top: 30px;">
      <div class="kpi-box"><div class="num">${data.totalRequests}</div><div class="lbl">Total</div></div>
      <div class="kpi-box"><div class="num">${data.rps}</div><div class="lbl">Req/sec</div></div>
    </div>
    <div class="kpi-row" style="margin-top: 10px;">
      <div class="kpi-box"><div class="num">${data.p95}ms</div><div class="lbl">p95</div></div>
      <div class="kpi-box"><div class="num">${data.avg}ms</div><div class="lbl">Avg</div></div>
    </div>
  </div>

  <div class="card">
    <h3>Test Configuration</h3>
    <div class="config-row"><b>Endpoint</b><div class="endpoint-box">${data.endpoint}</div></div>
    <div class="config-row"><b>Virtual Users</b>${data.vu}</div>
    <div class="config-row"><b>Response Threshold</b>p95 &lt; ${data.thresholdMs ?? '-'} ms</div>
  </div>

  <div class="card wide-card">
    <h3>Response Time vs Threshold (ms)</h3>
    ${data.thresholdMs ? `<div class="chart-legend"><span class="dash-line"></span> Threshold: ${data.thresholdMs}ms</div>` : ''}
    ${barChartSvg}
  </div>

  <div class="card wide-card">
    <h3>Checks Breakdown</h3>
    <table>
      <thead><tr><th>Check</th><th>Passes</th><th>Fails</th></tr></thead>
      <tbody>
        ${data.checks.map((c) => `<tr><td class="${c.fails > 0 ? 'fail-text' : ''}">${c.name}</td><td>${c.passes}</td><td class="${c.fails > 0 ? 'fail-text' : 'pass-text'}">${c.fails}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>

  <div class="card wide-card">
    <h3>Recommendations</h3>
    <ul class="rec-list">
      ${data.durationPassed === false ? `<li>Response time exceeded the threshold (avg ${data.avg}ms, p95 ${data.p95}ms). Consider re-running with fewer virtual users to find the breaking point, or checking server-side bottlenecks.</li>` : ''}
      ${data.errorPassed === false ? `<li>The error rate threshold was breached. Check reports/summary.json for failed status codes, and confirm the endpoint URL, auth token, and request body.</li>` : ''}
      ${data.overallPass ? `<li>All thresholds passed. Consider gradually increasing target Virtual Users in future runs to find the actual capacity limit.</li>` : ''}
    </ul>
  </div>
</div>
</body>
</html>`;

fs.writeFileSync(OUTPUT_PATH, html, 'utf-8');
console.log(`HTML dashboard written to ${OUTPUT_PATH}`);
