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
const checksList = collectChecks(summary.root_group, []);

const checksPassRate = Math.round((checksAgg.rate || 0) * 100);
const errorRatePct = Math.round((reqFailed.rate || 0) * 10000) / 100;
const thresholdMs = parseFloat((durationInfo.expressions[0] || '').match(/<\s*([\d.]+)/)?.[1]);

const ORANGE = '#E8A33D', BLUE = '#3D9BE8', GREEN = '#2E9E4F', RED = '#D9534F';
const DARK = '#2B2B2B', GRAY = '#8A8A8A', LIGHT_BG = '#F5F5F5', BORDER = '#E5E5E5';

const MARGIN = 40;
const doc = new PDFDocument({ margin: MARGIN, size: 'A4', bufferPages: true });
doc.pipe(fs.createWriteStream(OUTPUT_PATH));

const PAGE_W = doc.page.width;
const CONTENT_W = PAGE_W - MARGIN * 2; // usable width
const GAP = 14;  // more breathing room between cards, tuned to still fit one page for a typical report

// ─── Card helper: draws a rounded background box, returns inner content area ──
function cardBox(x, y, w, h, title) {
  doc.roundedRect(x, y, w, h, 8).fillColor('#FFFFFF').fill();
  doc.roundedRect(x, y, w, h, 8).strokeColor(BORDER).lineWidth(0.7).stroke();
  if (title) {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRAY)
      .text(title.toUpperCase(), x + 12, y + 10, { width: w - 24, characterSpacing: 0.3 });
  }
  return { innerX: x + 12, innerY: y + (title ? 26 : 12), innerW: w - 24 };
}

function drawGauge(cx, cy, r, value, color) {
  const clamped = Math.max(0, Math.min(100, value));
  const endAngle = Math.PI + (Math.PI * clamped / 100);
  const arcX = cx + r * Math.cos(endAngle);
  const arcY = cy + r * Math.sin(endAngle);
  const largeArc = clamped > 50 ? 1 : 0;
  doc.path(`M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy}`).lineWidth(9).strokeColor('#EDEDED').stroke();
  doc.path(`M ${cx - r} ${cy} A ${r} ${r} 0 ${largeArc} 1 ${arcX} ${arcY}`).lineWidth(9).strokeColor(color).stroke();
}

// ─── Header ─────────────────────────────────────────────────────────────────
doc.fillColor(ORANGE).fontSize(20).font('Helvetica-Bold').text('API Load Test Dashboard', MARGIN, MARGIN, { width: CONTENT_W, align: 'center' });
doc.moveDown(0.25);
doc.strokeColor(BLUE).lineWidth(1).moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).stroke();
doc.moveDown(0.35);
doc.fillColor(GRAY).fontSize(8.5).font('Helvetica').text(new Date().toLocaleString(), { width: CONTENT_W, align: 'center' });
doc.moveDown(0.3);
doc.fontSize(12).font('Helvetica-Bold').fillColor(overallPass ? GREEN : RED)
  .text(overallPass ? 'PASS  -  all thresholds met' : 'FAIL  -  one or more thresholds breached', { width: CONTENT_W, align: 'center' });
doc.moveDown(0.6);

// ─── Row 1: three cards — Checks gauge / Error gauge / Requests KPI ────────
const row1Y = doc.y;
const row1H = 104;
const cardW3 = (CONTENT_W - GAP * 2) / 3;

const checksColor = checksPassRate >= 90 ? GREEN : checksPassRate >= 50 ? ORANGE : RED;
const c1 = cardBox(MARGIN, row1Y, cardW3, row1H, 'Checks Passed');
drawGauge(c1.innerX + c1.innerW / 2, c1.innerY + 44, 38, checksPassRate, checksColor);
doc.font('Helvetica-Bold').fontSize(15).fillColor(DARK).text(`${checksPassRate}%`, c1.innerX, c1.innerY + 32, { width: c1.innerW, align: 'center' });
doc.font('Helvetica').fontSize(7.5).fillColor(GRAY).text('Overall check pass rate', c1.innerX, c1.innerY + 62, { width: c1.innerW, align: 'center' });

const errorColor = errorInfo.passed === false ? RED : GREEN;
const c2x = MARGIN + cardW3 + GAP;
const c2 = cardBox(c2x, row1Y, cardW3, row1H, 'Error Rate');
drawGauge(c2.innerX + c2.innerW / 2, c2.innerY + 44, 38, Math.min(errorRatePct, 100), errorColor);
doc.font('Helvetica-Bold').fontSize(15).fillColor(DARK).text(`${errorRatePct}%`, c2.innerX, c2.innerY + 32, { width: c2.innerW, align: 'center' });
doc.font('Helvetica').fontSize(7.5).fillColor(GRAY).text(`Threshold: < ${config.maxErrorRate || '-'}%`, c2.innerX, c2.innerY + 62, { width: c2.innerW, align: 'center' });

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
  doc.font('Helvetica').fontSize(7).fillColor(GRAY).text(k.label, kx, c3.innerY + 16, { width: kpiColW });
});
const kpis2 = [
  { label: 'p95', value: `${Math.round(reqDuration['p(95)'] || 0)} ms` },
  { label: 'Avg', value: `${Math.round(reqDuration.avg || 0)} ms` },
];
kpis2.forEach((k, i) => {
  const kx = c3.innerX + i * (kpiColW + 8);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK).text(k.value, kx, c3.innerY + 44, { width: kpiColW, lineBreak: false });
  doc.font('Helvetica').fontSize(7).fillColor(GRAY).text(k.label, kx, c3.innerY + 60, { width: kpiColW });
});

doc.y = row1Y + row1H + GAP;

// ─── Row 2: full-width Test Configuration card ─────────────────────────────
const cfgLines = [
  `${config.method || '-'} ${config.endpoint || '-'}`,
];
doc.font('Helvetica').fontSize(8);
const endpointHeight = doc.heightOfString(cfgLines[0], { width: CONTENT_W - 24 - 90 });

const titleOffset = 26;
const rowGap = 18;
const bottomPadding = 20;
const cfgCardH = titleOffset + Math.max(12, endpointHeight) + rowGap + 12 + rowGap + 12 + bottomPadding;

const cfg = cardBox(MARGIN, doc.y, CONTENT_W, cfgCardH, 'Test Configuration');
doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DARK).text('Endpoint', cfg.innerX, cfg.innerY, { width: 90 });
doc.font('Helvetica').fontSize(8).fillColor(DARK)
  .text(cfgLines[0], cfg.innerX + 90, cfg.innerY, { width: cfg.innerW - 90 });

let cfgY2 = cfg.innerY + Math.max(12, endpointHeight) + rowGap;
doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DARK).text('Virtual Users', cfg.innerX, cfgY2, { width: 90, continued: false });
doc.font('Helvetica').fontSize(8).fillColor(DARK)
  .text(`${config.startVU || '-'} -> ${config.targetVU || '-'}  (ramp ${config.rampTime || '-'})`, cfg.innerX + 90, cfgY2, { width: cfg.innerW - 90 });

cfgY2 += rowGap;
doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DARK).text('Thresholds', cfg.innerX, cfgY2, { width: 90 });
doc.font('Helvetica').fontSize(8).fillColor(DARK)
  .text(`${durationInfo.expressions.map(friendlyThreshold).join(', ') || '-'}  |  ${errorInfo.expressions.map(friendlyThreshold).join(', ') || '-'}`,
    cfg.innerX + 90, cfgY2, { width: cfg.innerW - 90 });

doc.y = row1Y + row1H + GAP + cfgCardH + GAP;

// ─── Row 3: Response Time bar chart card ───────────────────────────────────
const chartCardH = 150;
const chart = cardBox(MARGIN, doc.y, CONTENT_W, chartCardH, 'Response Time vs Threshold (ms)');

if (thresholdMs) {
  doc.fontSize(7.5).fillColor(GRAY).text(`- - -  Threshold: ${thresholdMs}ms`, chart.innerX, chart.innerY);
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

doc.y = row1Y + row1H + GAP + cfgCardH + GAP + chartCardH + GAP;

// ─── Row 4: Checks Breakdown card ──────────────────────────────────────────
if (checksList.length > 0) {
  const rowH = 16;
  const tableCardH = 34 + checksList.length * rowH + 8;
  const tbl = cardBox(MARGIN, doc.y, CONTENT_W, tableCardH, 'Checks Breakdown');

  const col1 = tbl.innerW * 0.6, col2 = tbl.innerW * 0.2, col3 = tbl.innerW * 0.2;
  let ty = tbl.innerY;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAY);
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

  doc.y = row1Y + row1H + GAP + cfgCardH + GAP + chartCardH + GAP + tableCardH + GAP;
}

// ─── Row 5: Recommendations card ───────────────────────────────────────────
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

const rec = cardBox(MARGIN, doc.y, CONTENT_W, recHeight, 'Recommendations');
let ry = rec.innerY;
recTexts.forEach((r) => {
  doc.font('Helvetica').fontSize(8.5).fillColor(DARK).text(r, rec.innerX, ry, { width: rec.innerW });
  ry += doc.heightOfString(r, { width: rec.innerW }) + 6;
});

doc.y = row1Y + row1H + GAP + cfgCardH + GAP + chartCardH + GAP + (checksList.length > 0 ? (34 + checksList.length * 16 + 8 + GAP) : 0) + recHeight + 14;
doc.fontSize(7.5).fillColor(GRAY).font('Helvetica-Oblique').text('Generated automatically after each k6 load test run.', MARGIN, doc.y, { width: CONTENT_W, align: 'center' });

// ─── Footer with page numbers on every page ────────────────────────────────
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
