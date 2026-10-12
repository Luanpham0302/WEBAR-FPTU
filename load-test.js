import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const VUS = Number(__ENV.VUS || 20);

const homepageDuration = new Trend(
  'homepage_duration',
  true
);

const targetDuration = new Trend(
  'target_duration',
  true
);

const supabaseDuration = new Trend(
  'supabase_duration',
  true
);

export const options = {
  scenarios: {
    open_ar_site: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '2m',
    },
  },

  thresholds: {
    http_req_failed: ['rate<0.01'],

    homepage_duration: [
      'p(95)<1000',
    ],

    target_duration: [
      'p(95)<5000',
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

  // =========================
  // 1. HOMEPAGE
  // =========================

  const homepage = http.get(
    `${SITE}/`
  );

  homepageDuration.add(
    homepage.timings.duration
  );

  check(homepage, {
    'homepage 200':
      (r) => r.status === 200,
  });


  // =========================
  // 2. MINDAR TARGET
  // =========================

  const target = http.get(
    `${SITE}/targets/targets.mind`
  );

  targetDuration.add(
    target.timings.duration
  );

  check(target, {
    'targets.mind 200':
      (r) => r.status === 200,
  });


  // =========================
  // 3. SUPABASE CONFIG
  // =========================

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