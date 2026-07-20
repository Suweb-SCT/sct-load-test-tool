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

function thresholdPassed(name) {
  const m = metrics[name];
  if (!m || !m.thresholds) return null;
  return Object.values(m.thresholds).every((t) => t.ok !== false);
}

const reqDuration = getMetricValues('http_req_duration');
const reqFailed = getMetricValues('http_req_failed');
const reqs = getMetricValues('http_reqs');
const checks = getMetricValues('checks');

const durationPassed = thresholdPassed('http_req_duration');
const errorPassed = thresholdPassed('http_req_failed');
const overallPass = durationPassed !== false && errorPassed !== false;

const doc = new PDFDocument({ margin: 50, size: 'A4' });
doc.pipe(fs.createWriteStream(OUTPUT_PATH));

const ORANGE = '#E8A33D';
const BLUE = '#3D9BE8';
const GREEN = '#2E9E4F';
const RED = '#D9534F';
const DARK = '#2B2B2B';
const GRAY = '#8A8A8A';

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
doc.moveDown(1.5);

doc.fontSize(14).font('Helvetica-Bold')
  .fillColor(overallPass ? GREEN : RED)
  .text(overallPass ? 'PASS - all thresholds met' : 'FAIL - one or more thresholds breached', {
    align: 'center',
  });
doc.moveDown(1.2);

function sectionTitle(text) {
  doc.moveDown(0.5);
  doc.fillColor(DARK).fontSize(13).font('Helvetica-Bold').text(text);
  doc.moveDown(0.3);
}

function row(label, value) {
  doc.fontSize(10).font('Helvetica-Bold').fillColor(DARK)
    .text(label, { continued: true, width: 220 });
  doc.font('Helvetica').fillColor(DARK).text(`  ${value}`);
}

sectionTitle('Test Configuration');
row('Endpoint:', `${config.method || '-'} ${config.endpoint || '-'}`);
row('Virtual Users:', `${config.startVU || '-'} -> ${config.targetVU || '-'} (ramp: ${config.rampTime || '-'})`);
row('Response Time Threshold (p95):', `< ${config.maxResponseTime || '-'} ms`);
row('Error Rate Threshold:', `< ${config.maxErrorRate || '-'} %`);

sectionTitle('Response Time (ms)');
row('Average:', fmt(reqDuration?.avg, ' ms'));
row('Minimum:', fmt(reqDuration?.min, ' ms'));
row('Median:', fmt(reqDuration?.med, ' ms'));
row('Maximum:', fmt(reqDuration?.max, ' ms'));
row('p(90):', fmt(reqDuration?.['p(90)'], ' ms'));
row('p(95):', fmt(reqDuration?.['p(95)'], ' ms'));
doc.fillColor(durationPassed === false ? RED : GREEN).font('Helvetica-Bold')
  .text(`Threshold: ${durationPassed === false ? 'FAILED' : 'PASSED'}`);

sectionTitle('Requests & Errors');
row('Total Requests:', fmt(reqs?.count));
row('Requests / sec:', fmt(reqs?.rate));
row('Error Rate:', fmt((reqFailed?.rate || 0) * 100, ' %'));
if (checks) row('Checks Passed:', fmt((checks?.rate || 0) * 100, ' %'));
doc.fillColor(errorPassed === false ? RED : GREEN).font('Helvetica-Bold')
  .text(`Threshold: ${errorPassed === false ? 'FAILED' : 'PASSED'}`);

doc.moveDown(1.5);
doc.fontSize(8).fillColor(GRAY).font('Helvetica-Oblique')
  .text('Generated automatically after each k6 load test run.', { align: 'center' });

doc.end();

console.log(`PDF report written to ${OUTPUT_PATH}`);
