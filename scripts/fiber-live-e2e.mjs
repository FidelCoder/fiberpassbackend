import fs from 'node:fs';
import path from 'node:path';

function readDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(
    fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

const fileEnv = readDotEnv(path.resolve('.env'));
function env(name, fallback = '') {
  return process.env[name] ?? fileEnv[name] ?? fallback;
}

const apiUrl = env('FIBERPASS_API_URL', 'http://localhost:4000').replace(/\/$/, '');
const cronSecret = env('CRON_SECRET');
const paymentRequest = process.argv[2] ?? env('FIBERPASS_LIVE_PAYMENT_REQUEST');
const amount = process.argv[3] ? Number(process.argv[3]) : Number(env('FIBERPASS_LIVE_TEST_AMOUNT_CKB', '0.01'));

if (!cronSecret) {
  console.error('Set CRON_SECRET before running live Fiber E2E.');
  process.exit(1);
}
if (!paymentRequest) {
  console.error('Pass a Fiber payment request as argv[2] or set FIBERPASS_LIVE_PAYMENT_REQUEST.');
  process.exit(1);
}

const response = await fetch(apiUrl + '/fiber/live-e2e', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + cronSecret
  },
  body: JSON.stringify({ paymentRequest, amount })
});
const body = await response.json().catch(() => null);
if (!response.ok) {
  console.error(JSON.stringify({ ok: false, status: response.status, body }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(body, null, 2));
