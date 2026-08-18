import dotenv from 'dotenv';
dotenv.config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000/api';
const SUPER_EMAIL = process.env.TEST_SUPER_ADMIN_EMAIL || '';
const SUPER_PASSWORD = process.env.TEST_SUPER_ADMIN_PASSWORD || '';

let superToken = '';
let adminAToken = '';
let adminBToken = '';
let orgA = '';
let orgB = '';
let clientA = '';
let clientB = '';
let planA = '';

const suffix = Date.now().toString(36);

function log(title: string) {
  console.log(`\n${'='.repeat(60)}\n  ${title}\n${'='.repeat(60)}`);
}

function ok(msg: string) {
  console.log(`  ✅ ${msg}`);
}

function fail(msg: string) {
  console.log(`  ❌ ${msg}`);
}

async function request(method: string, path: string, body?: any, token?: string): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data: any = await res.json().catch(() => null);
  return { status: res.status, data };
}

function expectStatus(actual: number, expected: number, label: string): void {
  if (actual === expected) ok(`${label} (HTTP ${actual})`);
  else fail(`${label}: se esperaba HTTP ${expected}, se obtuvo ${actual}.`);
}

async function main(): Promise<void> {
  if (!SUPER_EMAIL || !SUPER_PASSWORD) {
    console.error('❌ Configura TEST_SUPER_ADMIN_EMAIL y TEST_SUPER_ADMIN_PASSWORD (.env).');
    process.exit(1);
  }

  log('1. LOGIN super-admin');
  const login = await request('POST', '/auth/login', { email: SUPER_EMAIL, password: SUPER_PASSWORD });
  if (login.status !== 200 || !login.data?.accessToken) {
    fail(`No se pudo loguear el super-admin (HTTP ${login.status})`);
    process.exit(1);
  }
  superToken = login.data.accessToken;
  if (login.data.user.role !== 'super-admin') {
    fail(`El usuario no es super-admin (rol: ${login.data.user.role})`);
    process.exit(1);
  }
  ok(`Logueado como ${login.data.user.email} (${login.data.user.role})`);

  log('2. CREAR ORGANIZACIONES');
  const orgARes = await request('POST', '/organizations', { name: `Org A Smoke ${suffix}` }, superToken);
  const orgBRes = await request('POST', '/organizations', { name: `Org B Smoke ${suffix}` }, superToken);
  if (orgARes.status !== 201 || orgBRes.status !== 201) {
    fail(`No se pudieron crear las organizaciones (A: ${orgARes.status}, B: ${orgBRes.status})`);
    process.exit(1);
  }
  orgA = orgARes.data.id;
  orgB = orgBRes.data.id;
  ok(`org_A=${orgA}`);
  ok(`org_B=${orgB}`);

  log('3. CREAR ADMIN A (org_A) Y ADMIN B (org_B)');
  const adminARes = await request('POST', '/auth/register', {
    name: 'Admin A Smoke',
    email: `smoke_admin_a_${suffix}@example.com`,
    password: 'AdminSmoke123',
    role: 'admin',
    organizationId: orgA,
  }, superToken);
  const adminBRes = await request('POST', '/auth/register', {
    name: 'Admin B Smoke',
    email: `smoke_admin_b_${suffix}@example.com`,
    password: 'AdminSmoke123',
    role: 'admin',
    organizationId: orgB,
  }, superToken);
  if (adminARes.status !== 201 || adminBRes.status !== 201) {
    fail(`No se pudieron crear los admins (A: ${adminARes.status}, B: ${adminBRes.status})`);
    process.exit(1);
  }
  ok(`admin_A1=${adminARes.data.user.id}`);
  ok(`admin_B1=${adminBRes.data.user.id}`);

  log('4. LOGIN admins');
  const loginA = await request('POST', '/auth/login', { email: adminARes.data.user.email, password: 'AdminSmoke123' });
  const loginB = await request('POST', '/auth/login', { email: adminBRes.data.user.email, password: 'AdminSmoke123' });
  if (loginA.status !== 200 || loginB.status !== 200) {
    fail('No se pudieron loguear los admins');
    process.exit(1);
  }
  adminAToken = loginA.data.accessToken;
  adminBToken = loginB.data.accessToken;
  ok(`admin_A1 org=${loginA.data.user.organizationId}, admin_B1 org=${loginB.data.user.organizationId}`);

  log('5. CREAR CLIENTES EN CADA ORG');
  const clientARes = await request('POST', '/clients', {
    firstName: 'Cliente', lastName: `A ${suffix}`, phone: `+5841000${suffix.slice(-4)}01`,
  }, adminAToken);
  const clientBRes = await request('POST', '/clients', {
    firstName: 'Cliente', lastName: `B ${suffix}`, phone: `+5841000${suffix.slice(-4)}02`,
  }, adminBToken);
  if (clientARes.status !== 201 || clientBRes.status !== 201) {
    fail(`No se pudieron crear clientes (A: ${clientARes.status}, B: ${clientBRes.status})`);
    process.exit(1);
  }
  clientA = clientARes.data.id;
  clientB = clientBRes.data.id;
  ok(`client_A=${clientA} (${clientARes.data.organizationId})`);
  ok(`client_B=${clientB} (${clientBRes.data.organizationId})`);

  log('6. AISLAMIENTO: admin_A1 lista clientes');
  const clientsA = await request('GET', '/clients', undefined, adminAToken);
  expectStatus(clientsA.status, 200, 'GET /clients (admin_A1)');
  const seesClientB = clientsA.data?.clients?.some((c: any) => c.id === clientB);
  if (seesClientB) fail('admin_A1 ve el cliente de org_B (FUGA DE TENANT)');
  else ok('admin_A1 NO ve el cliente de org_B');

  log('7. IDOR: admin_A1 crea suscripción con client_B');
  const planARes = await request('POST', '/plans', {
    name: `Plan A ${suffix}`, price: 35, description: 'Smoke',
  }, adminAToken);
  if (planARes.status !== 201) {
    fail(`No se pudo crear el plan en org_A (${planARes.status})`);
    process.exit(1);
  }
  planA = planARes.data.id;
  ok(`plan_A=${planA}`);

  const crossSub = await request('POST', '/subscriptions', {
    clientId: clientB,
    planId: planA,
    kitNumber: `KIT-${suffix}-CROSS`,
    billingDay: 5,
    maxOverduePeriods: 2,
  }, adminAToken);
  expectStatus(crossSub.status, 403, 'POST /subscriptions client_B (admin_A1)');
  if (crossSub.status === 403) ok(`Código: ${crossSub.data?.error?.code}`);

  log('8. QUERY INJECTION: admin_A1 GET /subscriptions?organizationId=org_B');
  const subsAWithFilter = await request('GET', `/subscriptions?organizationId=${orgB}`, undefined, adminAToken);
  expectStatus(subsAWithFilter.status, 200, 'GET /subscriptions?organizationId=org_B (admin_A1)');
  const leakedB = subsAWithFilter.data?.subscriptions?.some((s: any) => s.organizationId === orgB);
  if (leakedB) fail('admin_A1 recibió suscripciones de org_B');
  else ok('admin_A1 ignora el filtro organizationId=org_B');

  log('9. SUPER-ADMIN filtra por org');
  const subsBAsSuper = await request('GET', `/subscriptions?organizationId=${orgB}`, undefined, superToken);
  expectStatus(subsBAsSuper.status, 200, 'GET /subscriptions?organizationId=org_B (super-admin)');
  const allFromB = subsBAsSuper.data?.subscriptions?.every((s: any) => s.organizationId === orgB);
  if (allFromB) ok('super-admin ve SOLO suscripciones de org_B');
  else fail('super-admin recibió datos fuera de org_B');

  log('10. SUPER-ADMIN sin filtro (todas)');
  const allSubs = await request('GET', '/subscriptions', undefined, superToken);
  expectStatus(allSubs.status, 200, 'GET /subscriptions (super-admin sin filtro)');

  log('11. admin_A1 GET /subscriptions/:id de client_B (directo)');
  const clientBDetail = await request('GET', `/clients/${clientB}`, undefined, adminAToken);
  expectStatus(clientBDetail.status, 404, 'GET /clients/{client_B} (admin_A1)');

  log('\n🎉 Smoke test multi-tenant completado.');
  console.log(`\n  Recursos creados (borrar en staging si aplica):`);
  console.log(`  org_A=${orgA}, org_B=${orgB}, client_A=${clientA}, client_B=${clientB}, plan_A=${planA}`);
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err);
  process.exit(1);
});
