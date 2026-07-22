// bootstrap.js
// ─────────────────────────────────────────────────────────────
// This is the ONLY command team members ever need to run:
//     node bootstrap.js
//
// Every time it runs, it:
//   1. Downloads the latest version of all project files from GitHub
//      (text files like .js are downloaded as UTF-8 text; binary files
//      like logo.png are downloaded as raw bytes so the image isn't
//      corrupted)
//   2. Overwrites the local copies
//   3. Then runs the load test (node run-load-test.js) as usual
// ─────────────────────────────────────────────────────────────

const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ── Configure your repo here (edit these 3 lines only if the repo moves) ──
const REPO_OWNER = 'Suweb-SCT';
const REPO_NAME = 'sct-load-test-tool';
const BRANCH = 'main';

// Text files are saved as UTF-8; binary files (images, fonts, etc.) are
// saved as raw bytes. Add new binary file extensions to BINARY_EXTENSIONS
// if you ever add more assets (e.g. a favicon or a second logo variant).
const FILES = [
  'run-load-test.js',
  'generate-pdf-report.js',
  'generate-html-report.js',
  'show-report.js',
  'load-tests/load-test.js',
  'logo.png',
  'modules.json',
];
const BINARY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf'];

function isBinary(filePath) {
  return BINARY_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

function rawUrl(filePath) {
  return `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}/${filePath}`;
}

// Downloads a URL and resolves with a Buffer (works for both text and binary;
// text files are converted to a UTF-8 string by the caller when needed).
function download(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'sct-load-test-bootstrap' } }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          return download(res.headers.location).then(resolve, reject);
        }
        if (res.statusCode === 404) {
          return reject(new Error(`Not found (404) — check the file exists in the repo at this exact path`));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

async function updateFiles() {
  console.log('\u{1F504}  Checking for the latest version...\n');

  for (const filePath of FILES) {
    try {
      const buffer = await download(rawUrl(filePath));
      const dir = path.dirname(filePath);
      if (dir !== '.' && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (isBinary(filePath)) {
        fs.writeFileSync(filePath, buffer); // raw bytes, no encoding
      } else {
        fs.writeFileSync(filePath, buffer.toString('utf-8'), 'utf-8');
      }
      console.log(`   \u2713 ${filePath}`);
    } catch (err) {
      console.error(`   \u2717 Failed to update ${filePath}: ${err.message}`);
      console.error('     Continuing with the local copy of this file, if one exists.');
    }
  }

  console.log('\n\u2705  Up to date.\n');
}

async function main() {
  await updateFiles();

  console.log('\u{1F680}  Starting the load test...\n');
  const result = spawnSync('node', ['run-load-test.js'], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

main();
