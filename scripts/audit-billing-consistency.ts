/**
 * Auditoría de solo lectura de la facturación. No escribe nada. Muestra IDs y conteos, sin
 * datos personales. Cada documento leído consume cuota de lectura de Firestore.
 *
 * Uso: npm run audit:billing
 */
import dotenv from 'dotenv';
import { initializeFirebase, getFirestore, admin } from '../src/infrastructure/firebase';
import { canOrganizationWrite } from '../src/domain/business-plan';
import { areSameDay, isPeriodPastDue } from '../src/domain/business-rules';

dotenv.config();

const PAGE_SIZE = 500;
const MAX_SAMPLES = 15;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MIN_CYCLE_DAYS = 28;

type Doc = FirebaseFirestore.DocumentData & { id: string };

function toDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  if (typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate();
  }
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

async function readAll(collection: string, fields: string[]): Promise<Doc[]> {
  const documents: Doc[] = [];
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = getFirestore()
      .collection(collection)
      .orderBy(admin.firestore.FieldPath.documentId())
      .select(...fields)
      .limit(PAGE_SIZE);
    if (last) query = query.startAfter(last);
    const snapshot = await query.get();
    snapshot.docs.forEach((doc) => documents.push({ id: doc.id, ...doc.data() }));
    if (snapshot.size < PAGE_SIZE) return documents;
    last = snapshot.docs[snapshot.docs.length - 1];
  }
}

function report(title: string, explanation: string, items: string[]): void {
  console.log(`\n${title}: ${items.length}`);
  console.log(`  ${explanation}`);
  items.slice(0, MAX_SAMPLES).forEach((item) => console.log(`  - ${item}`));
  if (items.length > MAX_SAMPLES) console.log(`  ... y ${items.length - MAX_SAMPLES} más.`);
}

async function main(): Promise<void> {
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.log(`Conectado al EMULADOR (${process.env.FIRESTORE_EMULATOR_HOST}), no a la base real.`);
  }
  initializeFirebase();

  const now = new Date();
  const [organizations, clients, subscriptions, periods] = await Promise.all([
    readAll('organizations', ['active', 'plan', 'planStatus', 'trialEndsAt', 'planExpiresAt']),
    readAll('clients', ['organizationId']),
    readAll('subscriptions', [
      'organizationId',
      'clientId',
      'status',
      'activationDate',
      'suspensionSource',
      'maxOverduePeriods',
      'currentPeriodId',
      'overduePeriods',
    ]),
    readAll('billingPeriods', ['organizationId', 'subscriptionId', 'startDate', 'endDate', 'status', 'amount']),
  ]);

  console.log(
    `Leídos: ${organizations.length} organizaciones, ${clients.length} clientes, ` +
      `${subscriptions.length} suscripciones, ${periods.length} períodos.`
  );

  const organizationsById = new Map(organizations.map((org) => [org.id, org]));
  const clientIds = new Set(clients.map((client) => client.id));
  const subscriptionIds = new Set(subscriptions.map((subscription) => subscription.id));
  const jobRunsFor = (organizationId: string): boolean => {
    const org = organizationsById.get(organizationId);
    if (!org || !org.active) return false;
    return canOrganizationWrite(
      {
        plan: org.plan,
        planStatus: org.planStatus,
        trialEndsAt: toDate(org.trialEndsAt) ?? null,
        planExpiresAt: toDate(org.planExpiresAt) ?? null,
      },
      now
    );
  };

  const periodsBySubscription = new Map<string, Array<Doc & { start: Date; end: Date }>>();
  const invalidDates: string[] = [];
  for (const period of periods) {
    const start = toDate(period.startDate);
    const end = toDate(period.endDate);
    if (!start || !end) {
      invalidDates.push(period.id);
      continue;
    }
    const list = periodsBySubscription.get(period.subscriptionId) ?? [];
    list.push({ ...period, start, end });
    periodsBySubscription.set(period.subscriptionId, list);
  }

  const duplicated: string[] = [];
  const overlapping: string[] = [];
  const frozen: string[] = [];
  const frozenWithoutJob: string[] = [];
  const legacySuspensions: string[] = [];
  const likelyManual: string[] = [];
  const shortFirstPeriods: string[] = [];
  const radarDrift: string[] = [];
  const noClient: string[] = [];
  let duplicatedAmount = 0;

  for (const subscription of subscriptions) {
    const list = (periodsBySubscription.get(subscription.id) ?? []).sort(
      (a, b) => a.start.getTime() - b.start.getTime()
    );
    const overdueCount = list.filter((period) => period.status === 'OVERDUE').length;

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i], list[j]];
        if (a.start.getTime() >= b.end.getTime() || b.start.getTime() >= a.end.getTime()) continue;
        const description = `sub ${subscription.id}: ${a.id} (${a.status}) y ${b.id} (${b.status})`;
        if (a.start.getTime() === b.start.getTime() && a.end.getTime() === b.end.getTime()) {
          duplicated.push(description);
          if (a.status !== 'PAID' || b.status !== 'PAID') {
            duplicatedAmount += Number(a.status !== 'PAID' ? a.amount : b.amount) || 0;
          }
        } else {
          overlapping.push(description);
        }
      }
    }

    const activation = toDate(subscription.activationDate);
    const latest = [...list].sort((a, b) => b.end.getTime() - a.end.getTime())[0];
    if (
      subscription.status === 'ACTIVE' &&
      activation &&
      latest &&
      latest.status === 'PENDING' &&
      areSameDay(latest.start, activation) &&
      isPeriodPastDue(latest.end, now)
    ) {
      const days = Math.floor((now.getTime() - latest.end.getTime()) / MS_PER_DAY);
      const description = `sub ${subscription.id}: período ${latest.id}, ${days} días detenida`;
      (jobRunsFor(subscription.organizationId) ? frozen : frozenWithoutJob).push(description);
    }

    if (subscription.status === 'SUSPENDED' && !subscription.suspensionSource) {
      legacySuspensions.push(subscription.id);
      if (overdueCount < (subscription.maxOverduePeriods ?? 1)) {
        likelyManual.push(`sub ${subscription.id}: ${overdueCount} vencidos, máximo ${subscription.maxOverduePeriods}`);
      }
    }

    if (activation && list[0] && areSameDay(list[0].start, activation)) {
      const days = (list[0].end.getTime() - list[0].start.getTime()) / MS_PER_DAY;
      if (days < MIN_CYCLE_DAYS) {
        shortFirstPeriods.push(`sub ${subscription.id}: ${days} días (${list[0].status})`);
      }
    }

    if (latest) {
      const latestByStart = list[list.length - 1];
      if (
        (subscription.currentPeriodId && subscription.currentPeriodId !== latestByStart.id) ||
        (subscription.overduePeriods !== undefined && subscription.overduePeriods !== overdueCount)
      ) {
        radarDrift.push(`sub ${subscription.id}: radar=${subscription.currentPeriodId}, real=${latestByStart.id}`);
      }
    }

    if (!clientIds.has(subscription.clientId)) {
      noClient.push(subscription.id);
    }
  }

  const orphanPeriods = periods.filter((period) => !subscriptionIds.has(period.subscriptionId)).map((period) => period.id);

  report(
    'Períodos duplicados (mismo rango)',
    `Cobros repetidos en potencia. Monto impago en duplicados: ${duplicatedAmount}.`,
    duplicated
  );
  report('Períodos solapados (rango distinto)', 'Cubren parte del mismo tiempo.', overlapping);
  report(
    'Suscripciones congeladas que se retomarán',
    'Al desplegar, el job les crea un período y empezarán a recibir avisos.',
    frozen
  );
  report(
    'Congeladas en organizaciones sin job',
    'Organización inactiva o con plan vencido: se retomarán cuando vuelva a estar activa.',
    frozenWithoutJob
  );
  report(
    'Suspensiones sin origen',
    'Se tratan como automáticas: saldar la deuda las reactiva.',
    legacySuspensions
  );
  report(
    '  De ellas, probablemente manuales',
    'Tienen menos vencidos que su máximo: un pago las reactivaría aunque se suspendieran a mano.',
    likelyManual
  );
  report('Primeros períodos cortos', 'Cobrados como mes completo con la regla anterior.', shortFirstPeriods);
  report('Radar desalineado', 'El resumen guardado no coincide con los períodos reales.', radarDrift);
  report('Suscripciones sin cliente', 'El cliente fue eliminado.', noClient);
  report('Períodos sin suscripción', 'La suscripción ya no existe.', orphanPeriods);
  report('Períodos con fechas inválidas', 'No se pudieron analizar.', invalidDates);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en la auditoría:', error);
    process.exit(1);
  });
