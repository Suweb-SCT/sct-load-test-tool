// Standalone command: reopens the most recently generated PDF report,
// without running a new test. Usage: node show-report.js
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const CHROME_PATHS_WIN = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

function findChromeWin() {
  return CHROME_PATHS_WIN.find((p) => p && fs.existsSync(p));
}

function openFile(filePath) {
  const platform = process.platform;
  const absPath = path.resolve(filePath);

  let cmd;
  let args;
  if (platform === 'win32') {
    const chromePath = findChromeWin();
    if (chromePath) {
      cmd = chromePath;
      args = [absPath];
    } else {
      cmd = 'explorer';
      args = [absPath];
    }
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = ['-a', 'Google Chrome', absPath];
  } else {
    cmd = 'google-chrome';
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
