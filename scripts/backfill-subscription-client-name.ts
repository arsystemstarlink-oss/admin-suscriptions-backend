import dotenv from 'dotenv';
import { initializeFirebase, getFirestore, admin } from '../src/infrastructure/firebase';
import { buildClientName, buildClientSortName } from '../src/domain/business-rules';

dotenv.config();

const PAGE_SIZE = 500;
const BATCH_SIZE = 400;

interface ClientNameRecord {
  firstName?: string;
  lastName?: string;
}

async function loadClients(
  db: FirebaseFirestore.Firestore
): Promise<Map<string, ClientNameRecord>> {
  const byId = new Map<string, ClientNameRecord>();
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  for (;;) {
    let query = db
      .collection('clients')
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
      byId.set(doc.id, { firstName: data.firstName, lastName: data.lastName });
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
  }

  return byId;
}

async function backfill(): Promise<void> {
  initializeFirebase();
  const db = getFirestore();

  console.log('Cargando clientes...');
  const clients = await loadClients(db);
  console.log(`Clientes cargados: ${clients.size}`);

  let processed = 0;
  let updated = 0;
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
      const data = doc.data();
      const client = clients.get(data.clientId);
      const clientName =
        buildClientName(client?.firstName, client?.lastName) ||
        data.clientName ||
        'Cliente no encontrado';
      const clientSortName = client
        ? buildClientSortName(client.firstName, client.lastName)
        : data.clientSortName || '\uffff';

      batch.update(doc.ref, { clientName, clientSortName });
      updated++;
    }
    await batch.commit();

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    processed += snapshot.docs.length;
    console.log(`  Actualizadas ${processed} suscripción(es)...`);
  }

  console.log(
    `Backfill de nombre de cliente completado. ${updated} suscripción(es) actualizadas.`
  );
}

backfill()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en backfill de nombre de cliente:', error);
    process.exit(1);
  });
