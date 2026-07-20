const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function openFile(filePath) {
  const platform = process.platform;
  const absPath = path.resolve(filePath);

  let cmd;
  let args;
  if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', absPath];
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = [absPath];
  } else {
    cmd = 'xdg-open';
    args = [absPath];
  }

  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

const reportPath = 'reports/load-test-report.pdf';

if (!fs.existsSync(reportPath)) {
  console.log('No PDF report found yet. Run "node run-load-test.js" first.');
  process.exit(1);
}

console.log('Opening the last load test PDF report...');
openFile(reportPath);
