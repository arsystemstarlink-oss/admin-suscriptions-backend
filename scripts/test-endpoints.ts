import dotenv from 'dotenv';
dotenv.config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000/api';
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || '';

let accessToken = '';

function log(title: string, data?: any) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
  if (data) console.log(JSON.stringify(data, null, 2));
}

function logOk(msg: string) {
  console.log(`  ✅ ${msg}`);
}

function logFail(msg: string) {
  console.log(`  ❌ ${msg}`);
}

async function request(method: string, path: string, body?: any, needsAuth = true): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (needsAuth) headers['Authorization'] = `Bearer ${accessToken}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data: any = await res.json().catch(() => null);

  if (!res.ok) {
    const error = data?.error || { code: 'UNKNOWN', message: `HTTP ${res.status}` };
    throw new Error(`${error.code}: ${error.message}`);
  }

  return data;
}

async function testLogin() {
  log('1. LOGIN - Obtener token JWT');

  if (!ADMIN_PASSWORD) {
    logFail('TEST_ADMIN_PASSWORD no configurada. Ejecuta primero: npm run create-admin');
    console.log('  Luego exporta la contraseña:');
    console.log('  $env:TEST_ADMIN_PASSWORD="tu-contraseña"');
    process.exit(1);
  }

  const data = await request('POST', '/auth/login', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  }, false);

  accessToken = data.accessToken;
  logOk(`Token obtenido (expira en 15 min)`);
  logOk(`Usuario: ${data.user.name} (${data.user.email})`);
  return data;
}

async function testCreateClient() {
  log('2. CREAR CLIENTE');

  const client = await request('POST', '/clients', {
    name: 'Carlos Mendoza',
    phone: '+584141234567',
    email: 'carlos.mendoza@example.com',
    address: 'Av. Principal 456, Maracaibo',
    notes: 'Cliente residencial - zona norte',
  });

  logOk(`Cliente creado: ${client.name}`);
  logOk(`ID: ${client.id}`);
  return client;
}

async function testCreatePlan() {
  log('3. CREAR PLAN');

  const plan = await request('POST', '/plans', {
    name: 'Residencial Plus',
    price: 40,
    description: 'Internet satelital residencial con velocidad mejorada',
    active: true,
  });

  logOk(`Plan creado: ${plan.name} - $${plan.price}/mes`);
  logOk(`ID: ${plan.id}`);
  return plan;
}

async function testCreateSubscription(clientId: string, planId: string) {
  log('4. CREAR SUSCRIPCIÓN');

  const data = await request('POST', '/subscriptions', {
    clientId,
    planId,
    kitNumber: 'KIT-2026-001',
    billingDay: 5,
    maxOverduePeriods: 2,
  });

  logOk(`Suscripción creada: ${data.subscription.id}`);
  logOk(`Estado: ${data.subscription.status}`);
  logOk(`Primer período: ${data.firstBillingPeriod.periodLabel} (${data.firstBillingPeriod.status})`);
  logOk(`Monto: $${data.firstBillingPeriod.amount}`);
  return data;
}

async function testListSubscriptions() {
  log('5. LISTAR SUSCRIPCIONES');

  const subscriptions = await request('GET', '/subscriptions');
  logOk(`${subscriptions.length} suscripcion(es) encontrada(s)`);
  subscriptions.forEach((s: any) => {
    console.log(`    - ${s.id} | Cliente: ${s.clientId} | Estado: ${s.status}`);
  });
  return subscriptions;
}

async function testGetSubscriptionWithPeriods(subscriptionId: string) {
  log('6. CONSULTAR SUSCRIPCIÓN CON PERÍODOS');

  const data = await request('GET', `/subscriptions/${subscriptionId}`);
  logOk(`Suscripción: ${data.subscription.status}`);
  logOk(`Períodos registrados: ${data.billingPeriods.length}`);
  data.billingPeriods.forEach((p: any) => {
    console.log(`    - ${p.periodLabel} | ${p.status} | $${p.amount}`);
  });
  return data;
}

async function testListBillingPeriods() {
  log('7. LISTAR TODOS LOS PERÍODOS');

  const periods = await request('GET', '/billing-periods');
  logOk(`${periods.length} período(s) en total`);
  periods.forEach((p: any) => {
    console.log(`    - ${p.periodLabel} | ${p.status} | Sub: ${p.subscriptionId.substring(0, 15)}...`);
  });
  return periods;
}

async function testUpdateSubscription(subscriptionId: string, newPlanId: string) {
  log('8. CAMBIAR PLAN DE SUSCRIPCIÓN');

  const updated = await request('PUT', `/subscriptions/${subscriptionId}`, {
    planId: newPlanId,
    kitNumber: 'KIT-2026-001-UPG',
  });

  logOk(`Plan actualizado: ${updated.planId}`);
  logOk(`Kit: ${updated.kitNumber}`);
  return updated;
}

async function testEvaluateOverdue() {
  log('9. EVALUAR VENCIMIENTOS');

  const result = await request('POST', '/billing-periods/evaluate-overdue');
  logOk(result.message);
  logOk(`Evaluado en: ${result.evaluatedAt}`);
  return result;
}

async function testListClients() {
  log('10. LISTAR CLIENTES');

  const clients = await request('GET', '/clients');
  logOk(`${clients.length} cliente(s) registrado(s)`);
  clients.forEach((c: any) => {
    console.log(`    - ${c.name} | ${c.phone} | ${c.email || 'sin email'}`);
  });
  return clients;
}

async function testListPlans() {
  log('11. LISTAR PLANES');

  const plans = await request('GET', '/plans');
  logOk(`${plans.length} plan(es) disponible(s)`);
  plans.forEach((p: any) => {
    console.log(`    - ${p.name} | $${p.price} | ${p.active ? 'Activo' : 'Inactivo'}`);
  });
  return plans;
}

async function testRefreshToken(refreshToken: string) {
  log('12. RENOVAR TOKEN');

  const data = await request('POST', '/auth/refresh', { refreshToken }, false);
  accessToken = data.accessToken;
  logOk('Token renovado correctamente');
  return data;
}

async function testUnauthorized() {
  log('13. VERIFICAR SEGURIDAD - Request sin token');

  try {
    await fetch(`${BASE_URL}/clients`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    logFail('Debería haber rechazado el request sin token');
  } catch {
    logOk('Request sin token rechazado correctamente');
  }
}

async function runAllTests() {
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     TEST DE ENDPOINTS - Sistema de Suscripciones       ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Base URL: ${BASE_URL}`);
  console.log(`  Admin: ${ADMIN_EMAIL}`);
  console.log(`  Fecha: ${new Date().toLocaleString('es-ES')}`);

  const startTime = Date.now();
  let passed = 0;
  let failed = 0;

  const tests = [
    { name: 'Login', fn: testLogin },
    { name: 'Crear Cliente', fn: testCreateClient },
    { name: 'Crear Plan', fn: testCreatePlan },
  ];

  let client: any;
  let plan: any;
  let subscriptionData: any;

  try {
    log('1. LOGIN - Obtener token JWT');
    const loginData = await testLogin();
    passed++;

    log('2. CREAR CLIENTE');
    client = await testCreateClient();
    passed++;

    log('3. CREAR PLAN');
    plan = await testCreatePlan();
    passed++;

    log('4. CREAR SUSCRIPCIÓN');
    subscriptionData = await testCreateSubscription(client.id, plan.id);
    passed++;

    log('5. LISTAR SUSCRIPCIONES');
    await testListSubscriptions();
    passed++;

    log('6. CONSULTAR SUSCRIPCIÓN CON PERÍODOS');
    await testGetSubscriptionWithPeriods(subscriptionData.subscription.id);
    passed++;

    log('7. LISTAR TODOS LOS PERÍODOS');
    await testListBillingPeriods();
    passed++;

    log('8. CAMBIAR PLAN DE SUSCRIPCIÓN');
    await testUpdateSubscription(subscriptionData.subscription.id, plan.id);
    passed++;

    log('9. EVALUAR VENCIMIENTOS');
    await testEvaluateOverdue();
    passed++;

    log('10. LISTAR CLIENTES');
    await testListClients();
    passed++;

    log('11. LISTAR PLANES');
    await testListPlans();
    passed++;

    log('12. RENOVAR TOKEN');
    await testRefreshToken(loginData.refreshToken);
    passed++;

    log('13. VERIFICAR SEGURIDAD - Request sin token');
    await testUnauthorized();
    passed++;

  } catch (error: any) {
    failed++;
    logFail(error.message);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║                    RESULTADOS                          ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  ✅ Pasaron:  ${passed}`.padEnd(58) + '║');
  console.log(`║  ❌ Fallaron: ${failed}`.padEnd(58) + '║');
  console.log(`║  ⏱️  Tiempo:   ${elapsed}s`.padEnd(58) + '║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log();
}

runAllTests().catch((error) => {
  console.error('Error inesperado:', error);
  process.exit(1);
});
