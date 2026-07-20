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

function getMetricValues(name) {
  return metrics[name] ? metrics[name].values : null;
}

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

const reqDuration = getMetricValues('http_req_duration');
const reqFailed = getMetricValues('http_req_failed');
const reqs = getMetricValues('http_reqs');
const checksAgg = getMetricValues('checks');

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

const doc = new PDFDocument({ margin: 50, size: 'A4' });
doc.pipe(fs.createWriteStream(OUTPUT_PATH));

const ORANGE = '#E8A33D';
const BLUE = '#3D9BE8';
const GREEN = '#2E9E4F';
const RED = '#D9534F';
const DARK = '#2B2B2B';
const GRAY = '#8A8A8A';
const LIGHT_BG = '#F5F5F5';

doc.fillColor(ORANGE).fontSize(22).font('Helvetica-Bold')
  .text('API Load Test Report', { align: 'center' });
doc.moveDown(0.3);
doc.strokeColor(BLUE).lineWidth(1)
  .moveTo(doc.page.margins.left, doc.y)
  .lineTo(doc.page.width - doc.page.margins.right, doc.y)
  .stroke();
doc.moveDown(0.6);
doc.fillColor(GRAY).fontSize(10).font('Helvetica')
  .text(new Date().toLocaleString(), { align: 'center' });
doc.moveDown(1.2);

doc.fontSize(14).font('Helvetica-Bold')
  .fillColor(overallPass ? GREEN : RED)
  .text(overallPass ? 'PASS - all thresholds met' : 'FAIL - one or more thresholds breached', {
    align: 'center',
  });
doc.moveDown(1);

function sectionTitle(text) {
  doc.moveDown(0.5);
  doc.fillColor(DARK).fontSize(13).font('Helvetica-Bold').text(text);
  doc.moveDown(0.3);
}

function row(label, value, valueColor) {
  doc.fontSize(10).font('Helvetica-Bold').fillColor(DARK)
    .text(label, { continued: true, width: 220 });
  doc.font('Helvetica').fillColor(valueColor || DARK).text(`  ${value}`);
}

sectionTitle('Test Configuration');
row('Endpoint:', `${config.method || '-'} ${config.endpoint || '-'}`);
row('Virtual Users:', `${config.startVU || '-'} -> ${config.targetVU || '-'} (ramp: ${config.rampTime || '-'})`);
row('Response Time Threshold:', durationInfo.expressions.map(friendlyThreshold).join(', ') || '-');
row('Error Rate Threshold:', errorInfo.expressions.map(friendlyThreshold).join(', ') || '-');

sectionTitle('Response Time (ms)');
row('Average:', fmt(reqDuration?.avg, ' ms'));
row('Minimum:', fmt(reqDuration?.min, ' ms'));
row('Median:', fmt(reqDuration?.med, ' ms'));
row('Maximum:', fmt(reqDuration?.max, ' ms'));
row('p(90):', fmt(reqDuration?.['p(90)'], ' ms'));
row('p(95):', fmt(reqDuration?.['p(95)'], ' ms'));
doc.fillColor(durationInfo.passed === false ? RED : GREEN).font('Helvetica-Bold')
  .text(`Threshold: ${durationInfo.passed === false ? 'FAILED' : 'PASSED'}`);

if (reqDuration) {
  doc.moveDown(0.6);
  const chartX = doc.x;
  const chartWidth = 380;
  const barHeight = 14;
  const gap = 8;
  const maxVal = Math.max(reqDuration.max || 1, ...(durationInfo.expressions
    .map((e) => parseFloat((e.match(/<\s*([\d.]+)/) || [])[1]) || 0)), 1);

  const bars = [
    { label: 'avg', value: reqDuration.avg, color: BLUE },
    { label: 'p90', value: reqDuration['p(90)'], color: ORANGE },
    { label: 'p95', value: reqDuration['p(95)'], color: RED },
  ];

  let barY = doc.y;
  bars.forEach((b) => {
    const w = Math.max(2, (b.value / maxVal) * chartWidth);
    doc.fontSize(8).fillColor(DARK).text(b.label, chartX, barY + 2, { width: 30 });
    doc.rect(chartX + 32, barY, chartWidth, barHeight).fillColor(LIGHT_BG).fill();
    doc.rect(chartX + 32, barY, w, barHeight).fillColor(b.color).fill();
    doc.fillColor(DARK).fontSize(8).text(`${Math.round(b.value)} ms`, chartX + 32 + chartWidth + 6, barY + 3);
    barY += barHeight + gap;
  });

  const thresholdMs = parseFloat((durationInfo.expressions[0] || '').match(/<\s*([\d.]+)/)?.[1]);
  if (thresholdMs) {
    const markerX = chartX + 32 + Math.min(chartWidth, (thresholdMs / maxVal) * chartWidth);
    doc.strokeColor(DARK).dash(2, { space: 2 })
      .moveTo(markerX, doc.y).lineTo(markerX, barY - gap)
      .stroke();
    doc.undash();
    doc.fontSize(7).fillColor(GRAY).text(`threshold (${thresholdMs}ms)`, markerX - 30, barY);
  }
  doc.y = barY + 14;
}

sectionTitle('Requests & Errors');
row('Total Requests:', fmt(reqs?.count));
row('Requests / sec:', fmt(reqs?.rate));
row('Error Rate:', fmt((reqFailed?.rate || 0) * 100, ' %'));
if (checksAgg) row('Overall Checks Passed:', fmt((checksAgg?.rate || 0) * 100, ' %'));
doc.fillColor(errorInfo.passed === false ? RED : GREEN).font('Helvetica-Bold')
  .text(`Threshold: ${errorInfo.passed === false ? 'FAILED' : 'PASSED'}`);

if (checksList.length > 0) {
  sectionTitle('Checks Breakdown');
  const tableX = doc.x;
  let tableY = doc.y;
  const col1 = 300, col2 = 80, col3 = 80;

  doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK);
  doc.text('Check', tableX, tableY, { width: col1, continued: true });
  doc.text('Passes', tableX + col1, tableY, { width: col2, continued: true });
  doc.text('Fails', tableX + col1 + col2, tableY, { width: col3 });
  tableY += 14;
  doc.moveTo(tableX, tableY).lineTo(tableX + col1 + col2 + col3, tableY).strokeColor('#DDDDDD').stroke();
  tableY += 4;

  doc.font('Helvetica').fontSize(9);
  checksList.forEach((c) => {
    const failed = (c.fails || 0) > 0;
    doc.fillColor(failed ? RED : DARK);
    doc.text(c.name || '-', tableX, tableY, { width: col1, continued: true });
    doc.text(String(c.passes || 0), tableX + col1, tableY, { width: col2, continued: true });
    doc.fillColor(failed ? RED : GREEN);
    doc.text(String(c.fails || 0), tableX + col1 + col2, tableY, { width: col3 });
    tableY += 14;
  });
  doc.y = tableY + 6;
}

sectionTitle('Recommendations');
const recs = [];
if (durationInfo.passed === false) {
  recs.push(
    `Response time exceeded the threshold (avg ${fmt(reqDuration?.avg, 'ms')}, p95 ${fmt(reqDuration?.['p(95)'], 'ms')}). ` +
    'Consider re-running with fewer virtual users to find the breaking point, checking for server-side ' +
    'bottlenecks (database queries, external calls), or confirming the threshold matches realistic expectations.'
  );
}
if (errorInfo.passed === false) {
  recs.push(
    'The error rate threshold was breached. Check reports/summary.json for failed request status codes, ' +
    'and confirm the endpoint URL, auth token, and request body are correct for this run.'
  );
}
if (recs.length === 0) {
  recs.push('All thresholds passed. Consider gradually increasing target Virtual Users in future runs to find the actual capacity limit.');
}
recs.forEach((r) => {
  doc.fontSize(9.5).font('Helvetica').fillColor(DARK).text(`- ${r}`, { width: 480 });
  doc.moveDown(0.4);
});

doc.moveDown(1);
doc.fontSize(8).fillColor(GRAY).font('Helvetica-Oblique')
  .text('Generated automatically after each k6 load test run.', { align: 'center' });

doc.end();

console.log(`PDF report written to ${OUTPUT_PATH}`);
