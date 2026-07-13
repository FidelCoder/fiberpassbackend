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
const checks = [];

async function getJson(route, label, required = true) {
  try {
    const response = await fetch(apiUrl + route);
    const body = await response.json().catch(() => null);
    const ok = response.ok && !body?.error;
    checks.push({ label, ok, required, status: response.status, route, body });
    return ok ? body : undefined;
  } catch (error) {
    checks.push({ label, ok: false, required, route, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

const health = await getJson('/health', 'Backend health');
const meta = await getJson('/meta', 'Backend metadata');
const readiness = await getJson('/fiber/node/readiness', 'Fiber node readiness', false);
const strategy = await getJson('/fiber/channels/strategy', 'Fiber channel strategy', false);

if (health && typeof health.mongo === 'string') {
  checks.push({
    label: 'MongoDB connection is ready',
    ok: health.mongo === 'connected',
    required: false,
    mongo: health.mongo
  });
}

if (readiness) {
  const alerts = Array.isArray(readiness.alerts) ? readiness.alerts : [];
  checks.push({
    label: 'Fiber node has no critical readiness alerts',
    ok: alerts.length === 0,
    required: false,
    alerts
  });
  checks.push({
    label: 'Fiber payment execution reports ready',
    ok: readiness.paymentExecution?.ready === true,
    required: false,
    paymentExecution: readiness.paymentExecution
  });
}

if (strategy) {
  const targets = Array.isArray(strategy.targetPeers) ? strategy.targetPeers : [];
  checks.push({
    label: 'At least one target Fiber peer configured',
    ok: targets.length > 0,
    required: false,
    targetPeers: targets
  });
}

const requiredFailures = checks.filter((check) => check.required && !check.ok);
const warnings = checks.filter((check) => !check.required && !check.ok);
const summary = {
  ok: requiredFailures.length === 0,
  apiUrl,
  checkedAt: new Date().toISOString(),
  backend: {
    health: health?.status ?? health,
    mode: meta?.mode,
    network: meta?.fiberNetwork
  },
  checks: checks.map(({ body, ...check }) => check),
  warnings: warnings.length,
  requiredFailures: requiredFailures.length
};

console.log(JSON.stringify(summary, null, 2));
if (requiredFailures.length > 0) process.exit(1);
