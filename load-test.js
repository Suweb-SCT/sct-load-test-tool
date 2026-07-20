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

  sleep(1);
}

export function handleSummary(data) {
  return {
    'reports/summary.json': JSON.stringify(data, null, 2),
    stdout: JSON.stringify({ note: 'Full summary written to reports/summary.json' }),
  };
}
