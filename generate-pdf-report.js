const fs = require('fs');
const PDFDocument = require('pdfkit');

const SUMMARY_PATH = 'reports/summary.json';
const CONFIG_PATH = 'reports/last-run-config.json';
const OUTPUT_PATH = 'reports/load-test-report.pdf';

if (!fs.existsSync(SUMMARY_PATH)) {
  console.error('Error: reports/summary.json not found - did the k6 run finish successfully?');
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf-8'));
const config = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  : {};

const metrics = summary.metrics || {};
function getMetricValues(name) { return metrics[name] ? metrics[name].values : null; }
function fmt(num, unit = '') {
  if (num === undefined || num === null || Number.isNaN(num)) return '-';
  return `${Math.round(num * 100) / 100}${unit}`;
}
function thresholdInfo(name) {
  const m = metrics[name];
  if (!m || !m.thresholds) return { passed: null, expressions: [] };
  const expressions = Object.keys(m.thresholds);
  const passed = Object.values(m.thresholds).every((t) => t.ok !== false);
  return { passed, expressions };
}
function friendlyThreshold(expr) {
  if (!expr) return '-';
  const rateMatch = expr.match(/^rate\s*<\s*([\d.]+)/);
  if (rateMatch) return `error rate < ${(parseFloat(rateMatch[1]) * 100).toFixed(2)} %`;
  const durMatch = expr.match(/^(p\(\d+\))\s*<\s*([\d.]+)/);
  if (durMatch) return `${durMatch[1]} < ${durMatch[2]} ms`;
  return expr;
}

function detectEnvironment(endpoint) {
  const text = (endpoint || '').toLowerCase();
  if (/localhost|127\.0\.0\.1|\.local\b|\.test\b/.test(text)) return { label: 'LOCAL', color: '#8A8A8A' };
  if (/staging|stage|uat|qa\./.test(text)) return { label: 'STAGING', color: '#E8A33D' };
  if (/prod(uction)?\./.test(text)) return { label: 'PRODUCTION', color: '#D9534F' };
  return null;
}

const reqDuration = getMetricValues('http_req_duration') || {};
const reqFailed = getMetricValues('http_req_failed') || {};
const reqs = getMetricValues('http_reqs') || {};
const checksAgg = getMetricValues('checks') || {};

const durationInfo = thresholdInfo('http_req_duration');
const errorInfo = thresholdInfo('http_req_failed');
const overallPass = durationInfo.passed !== false && errorInfo.passed !== false;

function collectChecks(group, acc) {
  if (!group) return acc;
  (group.checks || []).forEach((c) => acc.push(c));
  (group.groups ? Object.values(group.groups) : []).forEach((g) => collectChecks(g, acc));
  return acc;
}
const rawChecksList = collectChecks(summary.root_group, []);

const CATEGORY_LABELS = {
  network: 'Network / Timeout (never reached server)',
  '4xx': 'Client errors (4xx \u2014 bad request, auth, not found)',
  '5xx': 'Server errors (5xx \u2014 server broke while handling it)',
};
const ERRCAT_RE = /^(?:\[(.+?)\]\s*)?__errcat__:(network|4xx|5xx)$/;

const checksList = [];
const errCatRows = [];
rawChecksList.forEach((c) => {
  const m = ERRCAT_RE.exec(c.name || '');
  if (m) {
    const count = c.fails || 0;
    if (count > 0) errCatRows.push({ endpointLabel: m[1] || null, category: m[2], count });
  } else {
    checksList.push(c);
  }
});

const totalErrorCount = errCatRows.reduce((sum, r) => sum + r.count, 0);
const hasEndpointLabels = errCatRows.some((r) => r.endpointLabel);
const errorBreakdown = errCatRows.map((r) => ({
  endpointLabel: r.endpointLabel,
  label: CATEGORY_LABELS[r.category] || r.category,
  count: r.count,
  pct: totalErrorCount > 0 ? Math.round((r.count / totalErrorCount) * 1000) / 10 : 0,
}));

const checksTotals = checksList.reduce((acc, c) => {
  acc.passes += c.passes || 0;
  acc.fails += c.fails || 0;
  return acc;
}, { passes: 0, fails: 0 });
const checksPassRate = (checksTotals.passes + checksTotals.fails) > 0
  ? Math.round((checksTotals.passes / (checksTotals.passes + checksTotals.fails)) * 100)
  : 100;
const errorRatePct = Math.round((reqFailed.rate || 0) * 10000) / 100;
const thresholdMs = parseFloat((durationInfo.expressions[0] || '').match(/<\s*([\d.]+)/)?.[1]);

const ORANGE = '#FFA600', BLUE = '#005981', GREEN = '#2E9E4F', RED = '#D9534F', PURPLE = '#6C5CE7';
const DARK = '#2B2B2B', GRAY = '#8A8A8A', LIGHT_BG = '#F5F5F5', BORDER = '#E5E5E5';

function getTestTypeInfo(testType) {
  if (testType === 'progressive') return { label: 'PROGRESSIVE STEP', color: ORANGE };
  if (testType === 'spike') return { label: 'SPIKE TEST', color: RED };
  if (testType === 'multi') return { label: 'MULTI-ENDPOINT TEST', color: PURPLE };
  return { label: 'LOAD TEST', color: BLUE };
}
const testTypeInfo = getTestTypeInfo(config.testType);

const MARGIN = 46;
const doc = new PDFDocument({ margin: MARGIN, size: 'A4', bufferPages: true });
doc.pipe(fs.createWriteStream(OUTPUT_PATH));

const PAGE_W = doc.page.width;
const CONTENT_W = PAGE_W - MARGIN * 2;
const GAP = 14;

function cardBox(x, y, w, h, title) {
  doc.roundedRect(x, y, w, h, 8).fillColor('#FFFFFF').fill();
  doc.roundedRect(x, y, w, h, 8).strokeColor(BORDER).lineWidth(0.7).stroke();
  if (title) {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DARK)
      .text(title.toUpperCase(), x + 12, y + 10, { width: w - 24, characterSpacing: 0.3 });
  }
  return { innerX: x + 12, innerY: y + (title ? 26 : 12), innerW: w - 24 };
}

function ensureSpace(neededHeight) {
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  if (doc.y + neededHeight > bottomLimit) {
    doc.addPage();
    doc.y = MARGIN;
  }
}

function drawGauge(cx, cy, r, value, color) {
  const clamped = Math.max(0, Math.min(100, value));
  const endAngle = Math.PI + (Math.PI * clamped / 100);
  const arcX = cx + r * Math.cos(endAngle);
  const arcY = cy + r * Math.sin(endAngle);
  doc.path(`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`).lineWidth(9).strokeColor('#EDEDED').stroke();
  doc.path(`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${arcX} ${arcY}`).lineWidth(9).strokeColor(color).stroke();
}

const LOGO_PATH = 'logo.png';
const hasLogo = fs.existsSync(LOGO_PATH);
let logoHeight = 0;
if (hasLogo) {
  try {
    const logoWidth = 120;
    doc.image(LOGO_PATH, PAGE_W - MARGIN - logoWidth, MARGIN, { width: logoWidth });
    logoHeight = 24;
  } catch (e) {
    console.error('Could not load logo.png:', e.message);
  }
}

const reportTitle = config.testType === 'multi' && config.endpoints
  ? `Multi-Endpoint Load Test (${config.endpoints.length} endpoints)`
  : (config.moduleName && config.sectionName && config.subsectionName)
    ? `${config.moduleName} — ${config.sectionName} — ${config.subsectionName}`
    : (config.moduleName && config.sectionName)
      ? `${config.moduleName} — ${config.sectionName}`
      : (config.moduleName && config.subsectionName)
        ? `${config.moduleName} — ${config.subsectionName}`
        : config.moduleName
          ? `${config.moduleName}`
          : 'API Load Test Dashboard';

const testTypeLabel = testTypeInfo.label;

doc.fillColor(BLUE).fontSize(20).font('Helvetica-Bold').text(reportTitle, MARGIN, MARGIN + logoHeight, { width: CONTENT_W, align: 'center' });
doc.moveDown(0.25);
doc.strokeColor(ORANGE).lineWidth(1).moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).stroke();
doc.moveDown(0.35);
if (reportTitle !== 'API Load Test Dashboard') {
  doc.fillColor(GRAY).fontSize(8.5).font('Helvetica').text('API Load Test Dashboard', MARGIN, doc.y, { width: CONTENT_W, align: 'center' });
}
doc.fillColor(GRAY).fontSize(8.5).font('Helvetica').text(new Date().toLocaleString(), MARGIN, doc.y, { width: CONTENT_W, align: 'center' });
doc.moveDown(0.25);

(function drawTestTypeBadge() {
  const label = testTypeInfo.label;
  doc.font('Helvetica-Bold').fontSize(8.5);
  const textW = doc.widthOfString(label) + label.length * 0.4;
  const padX = 14, padY = 6;
  const boxW = textW + padX * 2;
  const boxH = 14 + padY;
  const boxX = MARGIN + (CONTENT_W - boxW) / 2;
  const boxY = doc.y;
  doc.roundedRect(boxX, boxY, boxW, boxH, boxH / 2).fillColor(testTypeInfo.color).fill();
  doc.fillColor('#FFFFFF').text(label, boxX, boxY + boxH / 2 - 5, { width: boxW, align: 'center', characterSpacing: 0.4 });
  doc.y = boxY + boxH;
})();
doc.moveDown(0.45);

doc.fontSize(12).font('Helvetica-Bold').fillColor(overallPass ? GREEN : RED)
  .text(overallPass ? 'PASS  -  all thresholds met' : 'FAIL  -  one or more thresholds breached', { width: CONTENT_W, align: 'center' });

const envInfo = detectEnvironment(config.endpoint);
if (envInfo) {
  doc.moveDown(0.3);
  doc.fontSize(7.5).font('Helvetica-Bold').fillColor(envInfo.color)
    .text(`ENVIRONMENT: ${envInfo.label}`, { width: CONTENT_W, align: 'center', characterSpacing: 0.5 });
}
doc.moveDown(0.9);

ensureSpace(112 + GAP);
const row1Y = doc.y;
const row1H = 112;
const cardW3 = (CONTENT_W - GAP * 2) / 3;

const checksColor = checksPassRate >= 90 ? GREEN : checksPassRate >= 50 ? ORANGE : RED;
const c1 = cardBox(MARGIN, row1Y, cardW3, row1H, 'Checks Passed');
drawGauge(c1.innerX + c1.innerW / 2, c1.innerY + 50, 36, checksPassRate, checksColor);
doc.font('Helvetica-Bold').fontSize(15).fillColor(DARK).text(`${checksPassRate}%`, c1.innerX, c1.innerY + 38, { width: c1.innerW, align: 'center' });
doc.font('Helvetica').fontSize(7.5).fillColor(DARK).text('Overall check pass rate', c1.innerX, c1.innerY + 68, { width: c1.innerW, align: 'center' });

const errorColor = errorInfo.passed === false ? RED : GREEN;
const c2x = MARGIN + cardW3 + GAP;
const c2 = cardBox(c2x, row1Y, cardW3, row1H, 'Error Rate');
drawGauge(c2.innerX + c2.innerW / 2, c2.innerY + 50, 36, Math.min(errorRatePct, 100), errorColor);
doc.font('Helvetica-Bold').fontSize(15).fillColor(DARK).text(`${errorRatePct}%`, c2.innerX, c2.innerY + 38, { width: c2.innerW, align: 'center' });
doc.font('Helvetica').fontSize(7.5).fillColor(DARK).text(`Threshold: < ${config.maxErrorRate || '-'}%`, c2.innerX, c2.innerY + 68, { width: c2.innerW, align: 'center' });

const c3x = MARGIN + (cardW3 + GAP) * 2;
const c3 = cardBox(c3x, row1Y, cardW3, row1H, 'Requests');
const kpis = [
  { label: 'Total Requests', value: fmt(reqs.count) },
  { label: 'Requests / sec', value: fmt(reqs.rate) },
];
const kpiColW = (c3.innerW - 8) / 2;
kpis.forEach((k, i) => {
  const kx = c3.innerX + i * (kpiColW + 8);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK).text(k.value, kx, c3.innerY, { width: kpiColW, lineBreak: false });
  doc.font('Helvetica').fontSize(7).fillColor(DARK).text(k.label, kx, c3.innerY + 16, { width: kpiColW });
});
const kpis2 = [
  { label: 'p95', value: `${Math.round(reqDuration['p(95)'] || 0)} ms` },
  { label: 'Avg', value: `${Math.round(reqDuration.avg || 0)} ms` },
];
kpis2.forEach((k, i) => {
  const kx = c3.innerX + i * (kpiColW + 8);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK).text(k.value, kx, c3.innerY + 44, { width: kpiColW, lineBreak: false });
  doc.font('Helvetica').fontSize(7).fillColor(DARK).text(k.label, kx, c3.innerY + 60, { width: kpiColW });
});

doc.y = row1Y + row1H + GAP;

const locationLabel = (config.moduleName && config.sectionName && config.subsectionName)
  ? `${config.moduleName} › ${config.sectionName} › ${config.subsectionName}`
  : (config.moduleName && config.sectionName)
    ? `${config.moduleName} › ${config.sectionName}`
    : null;

const endpointText = (config.testType === 'multi' && Array.isArray(config.endpoints))
  ? config.endpoints.map((e) => `[w${e.weight || 1}] ${e.method} ${e.url}`).join('   |   ')
  : `${config.method || '-'} ${config.endpoint || '-'}`;

const vuText = config.testType === 'spike'
  ? `${config.startVU || '-'} baseline → ${config.targetVU || '-'} spike  (jump ${config.rampTime || '-'}, hold ${config.spikeHold || '-'}, recover ${config.recoveryTime || '-'})`
  : `${config.startVU || '-'} -> ${config.targetVU || '-'}  (ramp ${config.rampTime || '-'})`;

doc.font('Helvetica').fontSize(8);
const endpointHeight = doc.heightOfString(endpointText, { width: CONTENT_W - 24 - 90 });

const titleOffset = 26;
const rowGap = 18;
const bottomPadding = 20;
const testTypeRowH = testTypeLabel ? rowGap : 0;
const locationRowH = locationLabel ? rowGap : 0;
const endpointLabel = config.testType === 'multi' ? 'Endpoints' : 'Endpoint';
const cfgCardH = titleOffset + testTypeRowH + locationRowH + Math.max(12, endpointHeight) + rowGap + 12 + rowGap + 12 + bottomPadding;

ensureSpace(cfgCardH + GAP);
const cfgTop = doc.y;
const cfg = cardBox(MARGIN, cfgTop, CONTENT_W, cfgCardH, 'Test Configuration');
let cfgY0 = cfg.innerY;
if (testTypeLabel) {
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DARK).text('Test Type', cfg.innerX, cfgY0, { width: 90 });
  doc.font('Helvetica').fontSize(8).fillColor(DARK).text(testTypeLabel, cfg.innerX + 90, cfgY0, { width: cfg.innerW - 90 });
  cfgY0 += testTypeRowH;
}
if (locationLabel) {
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DARK).text('Location', cfg.innerX, cfgY0, { width: 90 });
  doc.font('Helvetica').fontSize(8).fillColor(DARK).text(locationLabel, cfg.innerX + 90, cfgY0, { width: cfg.innerW - 90 });
  cfgY0 += locationRowH;
}
doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DARK).text(endpointLabel, cfg.innerX, cfgY0, { width: 90 });
doc.font('Helvetica').fontSize(8).fillColor(DARK)
  .text(endpointText, cfg.innerX + 90, cfgY0, { width: cfg.innerW - 90 });

let cfgY2 = cfgY0 + Math.max(12, endpointHeight) + rowGap;
doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DARK).text('Virtual Users', cfg.innerX, cfgY2, { width: 90, continued: false });
doc.font('Helvetica').fontSize(8).fillColor(DARK)
  .text(vuText, cfg.innerX + 90, cfgY2, { width: cfg.innerW - 90 });

cfgY2 += rowGap;
doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DARK).text('Thresholds', cfg.innerX, cfgY2, { width: 90 });
doc.font('Helvetica').fontSize(8).fillColor(DARK)
  .text(`${durationInfo.expressions.map(friendlyThreshold).join(', ') || '-'}  |  ${errorInfo.expressions.map(friendlyThreshold).join(', ') || '-'}`,
    cfg.innerX + 90, cfgY2, { width: cfg.innerW - 90 });

doc.y = cfgTop + cfgCardH + GAP;

const chartCardH = 150;
ensureSpace(chartCardH + GAP);
const chartTop = doc.y;
const chart = cardBox(MARGIN, chartTop, CONTENT_W, chartCardH, 'Response Time vs Threshold (ms)');

if (thresholdMs) {
  doc.fontSize(7.5).fillColor(DARK).text(`- - -  Threshold: ${thresholdMs}ms`, chart.innerX, chart.innerY);
}
const barsAreaY = chart.innerY + 14;
const barLabelW = 28;
const barValueW = 55;
const barTrackW = chart.innerW - barLabelW - barValueW - 8;
const barHeight = 12, barGap = 10;

const bars = [
  { label: 'avg', value: reqDuration.avg, color: BLUE },
  { label: 'p90', value: reqDuration['p(90)'], color: ORANGE },
  { label: 'p95', value: reqDuration['p(95)'], color: RED },
];
const maxVal = Math.max(reqDuration.max || 1, thresholdMs || 0, 1) * 1.1;
let by = barsAreaY;
const trackX = chart.innerX + barLabelW;
bars.forEach((b) => {
  const w = Math.max(2, (b.value / maxVal) * barTrackW);
  doc.fontSize(8).fillColor(DARK).text(b.label, chart.innerX, by + 2, { width: barLabelW });
  doc.rect(trackX, by, barTrackW, barHeight).fillColor(LIGHT_BG).fill();
  doc.rect(trackX, by, w, barHeight).fillColor(b.color).fill();
  doc.fillColor(DARK).fontSize(8).text(`${Math.round(b.value)} ms`, trackX + barTrackW + 6, by + 2, { width: barValueW });
  by += barHeight + barGap;
});
if (thresholdMs) {
  const markerX = trackX + Math.min(barTrackW, (thresholdMs / maxVal) * barTrackW);
  doc.strokeColor(DARK).dash(2, { space: 2 }).moveTo(markerX, barsAreaY).lineTo(markerX, by - barGap).stroke();
  doc.undash();
}

doc.y = chartTop + chartCardH + GAP;

if (checksList.length > 0) {
  const rowH = 16;
  const tableCardH = 34 + checksList.length * rowH + 8;
  ensureSpace(tableCardH + GAP);
  const tblTop = doc.y;
  const tbl = cardBox(MARGIN, tblTop, CONTENT_W, tableCardH, 'Checks Breakdown');

  const col1 = tbl.innerW * 0.6, col2 = tbl.innerW * 0.2, col3 = tbl.innerW * 0.2;
  let ty = tbl.innerY;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(DARK);
  doc.text('Check', tbl.innerX, ty, { width: col1 });
  doc.text('Passes', tbl.innerX + col1, ty, { width: col2 });
  doc.text('Fails', tbl.innerX + col1 + col2, ty, { width: col3 });
  ty += 14;
  doc.moveTo(tbl.innerX, ty).lineTo(tbl.innerX + col1 + col2 + col3, ty).strokeColor(BORDER).stroke();
  ty += 4;

  doc.font('Helvetica').fontSize(8.5);
  checksList.forEach((c, idx) => {
    if (idx % 2 === 1) {
      doc.rect(tbl.innerX - 4, ty - 3, col1 + col2 + col3 + 8, rowH).fillColor(LIGHT_BG).fill();
    }
    const failed = (c.fails || 0) > 0;
    doc.fillColor(failed ? RED : DARK).text(c.name || '-', tbl.innerX, ty, { width: col1 });
    doc.fillColor(DARK).text(String(c.passes || 0), tbl.innerX + col1, ty, { width: col2 });
    doc.fillColor(failed ? RED : GREEN).text(String(c.fails || 0), tbl.innerX + col1 + col2, ty, { width: col3 });
    ty += rowH;
  });

  doc.y = tblTop + tableCardH + GAP;
}

const errRowH = 14;
const errorCardH = errorBreakdown.length > 0 ? (32 + errorBreakdown.length * errRowH + 6) : 0;
if (errorBreakdown.length > 0) {
  ensureSpace(errorCardH + GAP);
  const errCardY = doc.y;
  const errCard = cardBox(MARGIN, errCardY, CONTENT_W, errorCardH, 'Error Breakdown');
  const ecol0 = hasEndpointLabels ? errCard.innerW * 0.28 : 0;
  const ecol1 = errCard.innerW * (hasEndpointLabels ? 0.5 : 0.72);
  const ecol2 = errCard.innerW - ecol0 - ecol1;
  let ety = errCard.innerY;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(DARK);
  if (hasEndpointLabels) doc.text('Endpoint', errCard.innerX, ety, { width: ecol0 });
  doc.text('Error Type', errCard.innerX + ecol0, ety, { width: ecol1 });
  doc.text('Count', errCard.innerX + ecol0 + ecol1, ety, { width: ecol2 });
  ety += 13;
  doc.moveTo(errCard.innerX, ety).lineTo(errCard.innerX + ecol0 + ecol1 + ecol2, ety).strokeColor(BORDER).stroke();
  ety += 3;

  doc.font('Helvetica').fontSize(8);
  errorBreakdown.forEach((e, idx) => {
    if (idx % 2 === 1) {
      doc.rect(errCard.innerX - 4, ety - 2, ecol0 + ecol1 + ecol2 + 8, errRowH).fillColor(LIGHT_BG).fill();
    }
    if (hasEndpointLabels) doc.fillColor(DARK).text(e.endpointLabel || '—', errCard.innerX, ety, { width: ecol0 });
    doc.fillColor(RED).text(e.label, errCard.innerX + ecol0, ety, { width: ecol1 });
    doc.fillColor(RED).text(`${e.count}  (${e.pct}%)`, errCard.innerX + ecol0 + ecol1, ety, { width: ecol2 });
    ety += errRowH;
  });

  doc.y = errCardY + errorCardH + GAP;
}

const recs = [];
if (durationInfo.passed === false) {
  recs.push(`Response time exceeded the threshold (avg ${fmt(reqDuration.avg, 'ms')}, p95 ${fmt(reqDuration['p(95)'], 'ms')}). Consider re-running with fewer virtual users to find the breaking point, checking for server-side bottlenecks, or confirming the threshold matches realistic expectations.`);
}
if (errorInfo.passed === false) {
  recs.push('The error rate threshold was breached. Check reports/summary.json for failed request status codes, and confirm the endpoint URL, auth token, and request body are correct for this run.');
}
if (recs.length === 0) {
  recs.push('All thresholds passed. Consider gradually increasing target Virtual Users in future runs to find the actual capacity limit.');
}

doc.font('Helvetica').fontSize(8.5);
const recTexts = recs.map((r, i) => recs.length > 1 ? `${i + 1}. ${r}` : `-  ${r}`);
let recHeight = 20;
recTexts.forEach((r) => { recHeight += doc.heightOfString(r, { width: CONTENT_W - 24 }) + 6; });

ensureSpace(recHeight + GAP);
const recTop = doc.y;
const rec = cardBox(MARGIN, recTop, CONTENT_W, recHeight, 'Recommendations');
let ry = rec.innerY;
recTexts.forEach((r) => {
  doc.font('Helvetica').fontSize(8.5).fillColor(DARK).text(r, rec.innerX, ry, { width: rec.innerW });
  ry += doc.heightOfString(r, { width: rec.innerW }) + 6;
});

doc.y = recTop + recHeight + 14;
ensureSpace(14);
doc.fontSize(7.5).fillColor(GRAY).font('Helvetica-Oblique').text('Generated automatically after each k6 load test run.', MARGIN, doc.y, { width: CONTENT_W, align: 'center' });

const pageRange = doc.bufferedPageRange();
for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
  doc.switchToPage(i);
  const savedBottomMargin = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.fontSize(7.5).fillColor(GRAY).font('Helvetica')
    .text(`Page ${i + 1} of ${pageRange.count}`, MARGIN, doc.page.height - 28, {
      width: CONTENT_W,
      align: 'center',
    });
  doc.page.margins.bottom = savedBottomMargin;
}

doc.end();
console.log(`PDF report written to ${OUTPUT_PATH}`);
