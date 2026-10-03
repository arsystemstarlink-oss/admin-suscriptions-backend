import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000/api';
const EMAIL = process.env.TEST_ADMIN_EMAIL || process.env.TEST_SUPER_ADMIN_EMAIL || '';
const PASSWORD = process.env.TEST_ADMIN_PASSWORD || process.env.TEST_SUPER_ADMIN_PASSWORD || '';
const ORGANIZATION_ID = process.env.TEST_ORGANIZATION_ID || '';
const ITERATIONS = Number(process.env.MEASURE_ITERATIONS || 10);

interface MetricsEntry {
  route: string;
  requests: number;
  queries: number;
  docReads: number;
  writes: number;
  aggregations: number;
  avgDurationMs: number;
}

let token = '';

async function api(method: string, path: string, body?: any): Promise<{ status: number; data: any; ms: number }> {
  const started = Date.now();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => null);
  return { status: res.status, data, ms: Date.now() - started };
}

async function getMetrics(): Promise<Map<string, MetricsEntry> | undefined> {
  const res = await api('GET', '/_metrics');
  if (res.status !== 200 || !Array.isArray(res.data?.metrics)) {
    return undefined;
  }
  const map = new Map<string, MetricsEntry>();
  for (const entry of res.data.metrics as MetricsEntry[]) {
    map.set(entry.route, entry);
  }
  return map;
}

function diff(
  before: Map<string, MetricsEntry> | undefined,
  after: Map<string, MetricsEntry> | undefined
): Map<string, { docReads: number; writes: number; queries: number }> {
  const result = new Map<string, { docReads: number; writes: number; queries: number }>();
  if (!before || !after) return result;
  for (const [route, entry] of after) {
    const prev = before.get(route) || { docReads: 0, writes: 0, queries: 0, requests: 0, aggregations: 0, avgDurationMs: 0 };
    result.set(route, {
      docReads: entry.docReads - prev.docReads,
      writes: entry.writes - prev.writes,
      queries: entry.queries - prev.queries,
    });
  }
  return result;
}

async function main(): Promise<void> {
  if (!EMAIL || !PASSWORD) {
    console.error('Configura TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD (o TEST_SUPER_ADMIN_*).');
    process.exit(1);
  }

  const login = await api('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
  if (login.status !== 200 || !login.data?.accessToken) {
    console.error(`No se pudo loguear (HTTP ${login.status}).`);
    process.exit(1);
  }
  token = login.data.accessToken;
  const orgQuery = ORGANIZATION_ID ? `?organizationId=${ORGANIZATION_ID}` : '';

  console.log(`Midiendo ${ITERATIONS} iteraciones por endpoint${ORGANIZATION_ID ? ` (org ${ORGANIZATION_ID})` : ''}...`);

  const clients = await api('GET', `/clients?limit=1${ORGANIZATION_ID ? `&organizationId=${ORGANIZATION_ID}` : ''}`);
  const clientId = clients.data?.clients?.[0]?.id;
  const subs = await api('GET', `/subscriptions?limit=1${ORGANIZATION_ID ? `&organizationId=${ORGANIZATION_ID}` : ''}`);
  const subscriptionId = subs.data?.subscriptions?.[0]?.id;
  const periods = await api('GET', `/billing-periods?limit=1${ORGANIZATION_ID ? `&organizationId=${ORGANIZATION_ID}` : ''}`);
  const periodId = periods.data?.periods?.[0]?.id;

  const endpoints: string[] = [
    `/dashboard/summary${orgQuery}`,
    `/dashboard/alerts${orgQuery}`,
    `/clients?limit=50${ORGANIZATION_ID ? `&organizationId=${ORGANIZATION_ID}` : ''}`,
    clientId ? `/clients/${clientId}${orgQuery}` : '',
    `/subscriptions?limit=20${ORGANIZATION_ID ? `&organizationId=${ORGANIZATION_ID}` : ''}`,
    `/billing-periods?limit=20${ORGANIZATION_ID ? `&organizationId=${ORGANIZATION_ID}` : ''}`,
    `/payment-reports?limit=20${ORGANIZATION_ID ? `&organizationId=${ORGANIZATION_ID}` : ''}`,
    periodId ? `/billing-periods/${periodId}${orgQuery}` : '',
    subscriptionId ? `/subscriptions/${subscriptionId}${orgQuery}` : '',
  ].filter(Boolean);

  const before = await getMetrics();
  const results: Array<{ endpoint: string; calls: number; avgMs: number; status: number }> = [];

  for (const endpoint of endpoints) {
    let totalMs = 0;
    let status = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const res = await api('GET', endpoint);
      totalMs += res.ms;
      status = res.status;
    }
    results.push({ endpoint, calls: ITERATIONS, avgMs: Math.round(totalMs / ITERATIONS), status });
  }

  const after = await getMetrics();
  const deltas = diff(before, after);

  console.log('\n== Resultados ==');
  console.log('endpoint'.padEnd(60) + 'calls'.padEnd(7) + 'avgMs'.padEnd(7) + 'docReads(delta)'.padEnd(18) + 'queries(delta)');
  for (const row of results) {
    const basePath = row.endpoint.split('?')[0];
    const candidates = [
      `GET /api${basePath}`,
      `GET /api${basePath.replace(/\/[^/]+$/, '/:id')}`,
    ];
    const delta = candidates.map((key) => deltas.get(key)).find((value) => value !== undefined);
    const reads = delta ? String(delta.docReads) : 'n/d';
    const queries = delta ? String(delta.queries) : 'n/d';
    console.log(
      row.endpoint.padEnd(60) +
        String(row.calls).padEnd(7) +
        String(row.avgMs).padEnd(7) +
        reads.padEnd(18) +
        queries
    );
    if (row.status >= 400) {
      console.log(`  ⚠️  ${row.endpoint} respondió HTTP ${row.status}`);
    }
  }

  if (!before || !after) {
    console.log('\nNota: habilita ENABLE_METRICS=true en el servidor para ver docReads/queries por ruta.');
  }
}

main().catch((error) => {
  console.error('Error midiendo endpoints:', error);
  process.exit(1);
});
