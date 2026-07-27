import http from 'k6/http';
import { check, sleep } from 'k6';

const ENDPOINT = __ENV.ENDPOINT;
const METHOD = (__ENV.METHOD || 'GET').toUpperCase();
const BODY = __ENV.BODY || '{}';
const API_TOKEN = __ENV.API_TOKEN || '';

const START_VU = parseInt(__ENV.START_VU || '10', 10);
const RAMP_TIME = __ENV.RAMP_TIME || '30s';
const TARGET_VU = parseInt(__ENV.TARGET_VU || '50', 10);
const MAX_RESPONSE_TIME = parseInt(__ENV.MAX_RESPONSE_TIME || '500', 10);
const MAX_ERROR_RATE = parseFloat(__ENV.MAX_ERROR_RATE || '1') / 100;

// How long to stay at TARGET_VU, and how long to ramp back down to 0.
// Defaults match the original hardcoded values, so normal/progressive
// load tests behave exactly as before. Spike tests override these to
// control how long the peak is held and how the cool-down looks.
const HOLD_TIME = __ENV.SPIKE_HOLD || '1m';
const RECOVERY_TIME = __ENV.RECOVERY_TIME || '30s';

const VALIDATE_ENABLED = (__ENV.VALIDATE_ENABLED || 'false') === 'true';
const VALIDATE_FIELD = __ENV.VALIDATE_FIELD || '';
const VALIDATE_MODE = __ENV.VALIDATE_MODE || 'exists'; // 'exists' | 'array' | 'equals'
const VALIDATE_VALUE = __ENV.VALIDATE_VALUE || '';

// Optional: a JSON array of { label, url, method, body, weight } to hit
// SEVERAL different endpoints in the same test, mixed together, instead of
// hammering just one. When not set (or invalid), falls back to the single
// ENDPOINT/METHOD/BODY above exactly as before — fully backward-compatible.
let ENDPOINT_LIST = null;
try {
  const parsed = JSON.parse(__ENV.ENDPOINTS || '');
  if (Array.isArray(parsed) && parsed.length > 0) ENDPOINT_LIST = parsed;
} catch (e) {
  ENDPOINT_LIST = null;
}

// Reads a nested field out of a parsed JSON body using dot notation,
// e.g. "data.items" reads body.data.items. Returns undefined if any
// part of the path is missing.
function getByPath(obj, path) {
  return path.split('.').filter(Boolean).reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

// Weighted random pick — an endpoint with weight 3 shows up ~3x as often
// as one with weight 1. Missing/invalid weights default to 1.
function pickWeighted(list) {
  const weights = list.map((e) => (Number(e.weight) > 0 ? Number(e.weight) : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

export const options = {
  stages: [
    { duration: RAMP_TIME, target: START_VU },
    { duration: RAMP_TIME, target: TARGET_VU },
    { duration: HOLD_TIME, target: TARGET_VU },
    { duration: RECOVERY_TIME, target: 0 },
  ],
  thresholds: {
    http_req_duration: [`p(95)<${MAX_RESPONSE_TIME}`],
    http_req_failed: [`rate<${MAX_ERROR_RATE}`],
  },
};

export default function () {
  const target = ENDPOINT_LIST ? pickWeighted(ENDPOINT_LIST) : {
    url: ENDPOINT, method: METHOD, body: BODY, label: null,
  };
  const targetMethod = (target.method || 'GET').toUpperCase();
  const targetBody = target.body || '{}';
  // Prefix check names with the endpoint's label when mixing several
  // endpoints, so the "Checks Breakdown" table shows which endpoint each
  // check belongs to instead of one ambiguous "status is 2xx" row.
  const prefix = target.label ? `[${target.label}] ` : '';

  const params = {
    headers: {
      'Content-Type': 'application/json',
      ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    },
  };

  let res;
  if (targetMethod === 'POST') {
    res = http.post(target.url, targetBody, params);
  } else if (targetMethod === 'PUT') {
    res = http.put(target.url, targetBody, params);
  } else if (targetMethod === 'DELETE') {
    res = http.del(target.url, null, params);
  } else {
    res = http.get(target.url, params);
  }

  check(res, {
    [`${prefix}status is 2xx`]: (r) => r.status >= 200 && r.status < 300,
    [`${prefix}response time < ${MAX_RESPONSE_TIME}ms`]: (r) => r.timings.duration < MAX_RESPONSE_TIME,
  });

  if (VALIDATE_ENABLED && VALIDATE_FIELD) {
    let parsedBody;
    try {
      parsedBody = JSON.parse(res.body);
    } catch (e) {
      parsedBody = null;
    }
    const fieldValue = parsedBody !== null ? getByPath(parsedBody, VALIDATE_FIELD) : undefined;

    let checkName;
    let checkFn;
    if (VALIDATE_MODE === 'array') {
      checkName = `${prefix}body.${VALIDATE_FIELD} is a non-empty array`;
      checkFn = () => Array.isArray(fieldValue) && fieldValue.length > 0;
    } else if (VALIDATE_MODE === 'equals') {
      checkName = `${prefix}body.${VALIDATE_FIELD} equals "${VALIDATE_VALUE}"`;
      checkFn = () => String(fieldValue) === VALIDATE_VALUE;
    } else {
      checkName = `${prefix}body.${VALIDATE_FIELD} exists`;
      checkFn = () => fieldValue !== undefined && fieldValue !== null;
    }
    check(res, { [checkName]: checkFn });
  }

  sleep(1);
}

export function handleSummary(data) {
  return {
    'reports/summary.json': JSON.stringify(data, null, 2),
    stdout: JSON.stringify({ note: 'Full summary written to reports/summary.json' }),
  };
}
