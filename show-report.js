// Standalone command: reopens the most recently generated PDF report,
// without running a new test. Usage: node show-report.js
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function openFile(filePath) {
  const platform = process.platform;
  const absPath = path.resolve(filePath);

  let cmd;
  let args;
  if (platform === 'win32') {
    cmd = 'explorer';
    args = [absPath];
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = [absPath];
  } else {
    cmd = 'xdg-open';
    args = [absPath];
  }

  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', (err) => {
    console.log(`   \u26A0\uFE0F  Could not auto-open ${absPath}: ${err.message}`);
  });
  child.unref();
}

const reportPath = 'reports/load-test-report.pdf';

if (!fs.existsSync(reportPath)) {
  console.log('⚠️  No PDF report found yet. Run "node run-load-test.js" first.');
  process.exit(1);
}

console.log('📊  Opening the last load test PDF report...');
openFile(reportPath);
