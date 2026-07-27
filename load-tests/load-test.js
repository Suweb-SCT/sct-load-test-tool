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

const VALIDATE_ENABLED = (__ENV.VALIDATE_ENABLED || 'false') === 'true';
const VALIDATE_FIELD = __ENV.VALIDATE_FIELD || '';
const VALIDATE_MODE = __ENV.VALIDATE_MODE || 'exists'; // 'exists' | 'array' | 'equals'
const VALIDATE_VALUE = __ENV.VALIDATE_VALUE || '';

// Reads a nested field out of a parsed JSON body using dot notation,
// e.g. "data.items" reads body.data.items. Returns undefined if any
// part of the path is missing.
function getByPath(obj, path) {
  return path.split('.').filter(Boolean).reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export const options = {
  stages: [
    { duration: RAMP_TIME, target: START_VU },
    { duration: RAMP_TIME, target: TARGET_VU },
    { duration: '1m', target: TARGET_VU },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: [`p(95)<${MAX_RESPONSE_TIME}`],
    http_req_failed: [`rate<${MAX_ERROR_RATE}`],
  },
};

export default function () {
  const params = {
    headers: {
      'Content-Type': 'application/json',
      ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    },
  };

  let res;
  if (METHOD === 'POST') {
    res = http.post(ENDPOINT, BODY, params);
  } else if (METHOD === 'PUT') {
    res = http.put(ENDPOINT, BODY, params);
  } else if (METHOD === 'DELETE') {
    res = http.del(ENDPOINT, null, params);
  } else {
    res = http.get(ENDPOINT, params);
  }

  check(res, {
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
    [`response time < ${MAX_RESPONSE_TIME}ms`]: (r) => r.timings.duration < MAX_RESPONSE_TIME,
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
      checkName = `body.${VALIDATE_FIELD} is a non-empty array`;
      checkFn = () => Array.isArray(fieldValue) && fieldValue.length > 0;
    } else if (VALIDATE_MODE === 'equals') {
      checkName = `body.${VALIDATE_FIELD} equals "${VALIDATE_VALUE}"`;
      checkFn = () => String(fieldValue) === VALIDATE_VALUE;
    } else {
      checkName = `body.${VALIDATE_FIELD} exists`;
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
