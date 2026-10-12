import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const VUS = Number(__ENV.VUS || 100);

const homepageDuration = new Trend(
  'homepage_duration',
  true
);

const supabaseDuration = new Trend(
  'supabase_duration',
  true
);

export const options = {
  scenarios: {
    server_load: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '2m',
    },
  },

  thresholds: {
    http_req_failed: ['rate<0.01'],

    homepage_duration: [
      'p(95)<1500',
    ],

    supabase_duration: [
      'p(95)<1000',
    ],
  },
};

const SITE = __ENV.SITE;
const SUPABASE_URL = __ENV.SUPABASE_URL;
const SUPABASE_KEY = __ENV.SUPABASE_KEY;

export default function () {
  const homepage = http.get(`${SITE}/`);

  homepageDuration.add(
    homepage.timings.duration
  );

  check(homepage, {
    'homepage 200':
      (r) => r.status === 200,
  });

  const config = http.get(
    `${SUPABASE_URL}/rest/v1/ar_content?id=eq.main&select=config`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization:
          `Bearer ${SUPABASE_KEY}`,
      },
    }
  );

  supabaseDuration.add(
    config.timings.duration
  );

  check(config, {
    'supabase config 200':
      (r) => r.status === 200,
  });
}