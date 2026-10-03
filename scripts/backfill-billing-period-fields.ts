import dotenv from 'dotenv';
import { initializeFirebase, getFirestore, admin } from '../src/infrastructure/firebase';

dotenv.config();

const PAGE_SIZE = 500;
const WRITE_BATCH_SIZE = 400;

interface SubscriptionIndexEntry {
  clientId?: string;
  planId?: string;
}

async function loadSubscriptionIndex(
  db: FirebaseFirestore.Firestore
): Promise<Map<string, SubscriptionIndexEntry>> {
  const index = new Map<string, SubscriptionIndexEntry>();
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
    if (snapshot.empty) break;

    for (const doc of snapshot.docs) {
      const data = doc.data();
      index.set(doc.id, { clientId: data.clientId, planId: data.planId });
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    console.log(`  Suscripciones indexadas: ${index.size}...`);
  }

  return index;
}

async function backfill(): Promise<void> {
  initializeFirebase();
  const db = getFirestore();

  console.log('Indexando suscripciones...');
  const subscriptionIndex = await loadSubscriptionIndex(db);

  let processed = 0;
  let updated = 0;
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
    if (snapshot.empty) break;

    const pending: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const subscription = data.subscriptionId ? subscriptionIndex.get(data.subscriptionId) : undefined;
      const patch: Record<string, unknown> = {};
      if (subscription?.clientId && data.clientId !== subscription.clientId) {
        patch.clientId = subscription.clientId;
      }
      if (subscription?.planId && data.planId !== subscription.planId) {
        patch.planId = subscription.planId;
      }
      if (Object.keys(patch).length > 0) {
        pending.push({ ref: doc.ref, data: patch });
      }
      processed++;
    }

    for (let i = 0; i < pending.length; i += WRITE_BATCH_SIZE) {
      const chunk = pending.slice(i, i + WRITE_BATCH_SIZE);
      const batch = db.batch();
      chunk.forEach((entry) => batch.update(entry.ref, entry.data));
      await batch.commit();
      updated += chunk.length;
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    console.log(`  Períodos procesados: ${processed}, actualizados: ${updated}...`);
  }

  console.log(`Backfill de billingPeriods completado. ${updated} período(s) actualizados.`);
}

backfill()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en backfill de billingPeriods:', error);
    process.exit(1);
  });
