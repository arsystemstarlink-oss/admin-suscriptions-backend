import dotenv from 'dotenv';
import { initializeFirebase, getFirestore, admin } from '../src/infrastructure/firebase';

dotenv.config();

const PAGE_SIZE = 500;

interface Coverage {
  total: number;
  missingCount: number;
  samples: string[];
}

async function scan(
  collectionName: string,
  isMissing: (data: FirebaseFirestore.DocumentData) => boolean,
  maxSamples = 10
): Promise<Coverage> {
  const db = getFirestore();
  const result: Coverage = { total: 0, missingCount: 0, samples: [] };
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  for (;;) {
    let query = db
      .collection(collectionName)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) break;

    for (const doc of snapshot.docs) {
      result.total++;
      if (isMissing(doc.data())) {
        result.missingCount++;
        if (result.samples.length < maxSamples) {
          result.samples.push(doc.id);
        }
      }
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
  }

  return result;
}

async function main(): Promise<void> {
  initializeFirebase();

  const subscriptions = await scan('subscriptions', (data) => data.radarRank === undefined || data.radarRank === null);
  const periods = await scan('billingPeriods', (data) => !data.clientId || !data.planId);

  console.log('\n== Cobertura de backfills ==');
  console.log(
    `subscriptions: ${subscriptions.total} total, ${subscriptions.missingCount} sin radarRank` +
      (subscriptions.samples.length > 0 ? ` (ej: ${subscriptions.samples.join(', ')})` : '')
  );
  console.log(
    `billingPeriods: ${periods.total} total, ${periods.missingCount} sin clientId/planId` +
      (periods.samples.length > 0 ? ` (ej: ${periods.samples.join(', ')})` : '')
  );

  const hasGaps = subscriptions.missingCount > 0 || periods.missingCount > 0;
  if (hasGaps) {
    console.log('\n⚠️  Hay documentos sin backfill. Ejecuta:');
    console.log('   npm run backfill:radar');
    console.log('   npm run backfill:billing-periods');
    process.exit(1);
  }

  console.log('\n✅ Cobertura completa.');
}

main().catch((error) => {
  console.error('Error verificando backfills:', error);
  process.exit(1);
});
