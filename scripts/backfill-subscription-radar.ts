import dotenv from 'dotenv';
import { initializeFirebase, getFirestore, admin } from '../src/infrastructure/firebase';
import { BillingPeriod } from '../src/domain/entities';
import { buildSubscriptionRadarFields } from '../src/infrastructure/subscription-radar';

dotenv.config();

const PAGE_SIZE = 500;
const WRITE_BATCH_SIZE = 400;

function toDate(value: any): Date {
  if (value instanceof Date) return value;
  if (value?.toDate) return value.toDate();
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

function stripUndefined(value: any): any {
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') {
    const cleaned: any = {};
    Object.keys(value).forEach((key) => {
      if (value[key] !== undefined) {
        cleaned[key] = stripUndefined(value[key]);
      }
    });
    return cleaned;
  }
  return value;
}

async function loadPeriodsBySubscription(db: FirebaseFirestore.Firestore): Promise<Map<string, BillingPeriod[]>> {
  const bySubscription = new Map<string, BillingPeriod[]>();
  let processed = 0;
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  for (;;) {
    let query = db
      .collection('billingPeriods')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      break;
    }

    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (!data.subscriptionId) continue;
      const period: BillingPeriod = {
        id: doc.id,
        organizationId: data.organizationId,
        subscriptionId: data.subscriptionId,
        periodLabel: data.periodLabel,
        startDate: toDate(data.startDate),
        endDate: toDate(data.endDate),
        amount: data.amount,
        status: data.status,
        paidAt: data.paidAt ? toDate(data.paidAt) : undefined,
        paymentMethod: data.paymentMethod,
        notes: data.notes,
        createdAt: data.createdAt ? toDate(data.createdAt) : toDate(data.startDate),
      };
      const list = bySubscription.get(period.subscriptionId) || [];
      list.push(period);
      bySubscription.set(period.subscriptionId, list);
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    processed += snapshot.docs.length;
    console.log(`  Procesados ${processed} períodos...`);
  }

  return bySubscription;
}

async function backfill(): Promise<void> {
  initializeFirebase();
  const db = getFirestore();

  console.log('Cargando períodos...');
  const periodsBySubscription = await loadPeriodsBySubscription(db);
  console.log(`Períodos agrupados para ${periodsBySubscription.size} suscripción(es).`);

  let processedSubscriptions = 0;
  let updatedSubscriptions = 0;
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  for (;;) {
    let query = db
      .collection('subscriptions')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      break;
    }

    const batch = db.batch();
    for (const doc of snapshot.docs) {
      const periods = periodsBySubscription.get(doc.id) || [];
      const fields = buildSubscriptionRadarFields(periods);
      batch.update(doc.ref, stripUndefined(fields));
      updatedSubscriptions++;
    }
    await batch.commit();

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    processedSubscriptions += snapshot.docs.length;
    console.log(`  Actualizadas ${processedSubscriptions} suscripción(es)...`);
  }

  console.log(
    `Backfill de radar de suscripciones completado. ${updatedSubscriptions} suscripción(es) actualizadas.`
  );
}

backfill()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en backfill de radar de suscripciones:', error);
    process.exit(1);
  });
