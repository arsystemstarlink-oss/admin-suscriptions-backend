import dotenv from 'dotenv';
import { initializeFirebase, getFirestore, admin } from '../src/infrastructure/firebase';
import {
  buildClientName,
  buildClientSortName,
  getClientNameUpdateFields,
} from '../src/domain/business-rules';

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

  let scanned = 0;
  let updated = 0;
  let missingClients = 0;
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

    const updates: Array<{
      ref: FirebaseFirestore.DocumentReference;
      clientId: string;
      fields: { clientName?: string; clientSortName?: string };
    }> = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const client = clients.get(data.clientId);
      if (!client) {
        missingClients++;
        console.warn(
          `[Backfill client-name] Suscripción ${doc.id}: cliente ${data.clientId || '(sin clientId)'} no encontrado; se omite.`
        );
        continue;
      }
      const fields = getClientNameUpdateFields(data, {
        clientName: buildClientName(client.firstName, client.lastName),
        clientSortName: buildClientSortName(client.firstName, client.lastName),
      });
      if (fields) updates.push({ ref: doc.ref, clientId: data.clientId, fields });
    }

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const chunk = updates.slice(i, i + BATCH_SIZE);
      const batch = db.batch();
      for (const update of chunk) {
        batch.update(update.ref, update.fields);
      }
      try {
        await batch.commit();
      } catch (error) {
        console.error('[Backfill client-name] Falló la escritura de un lote; puedes volver a ejecutar el script.', {
          committedBeforeFailure: updated,
          failedBatchSize: chunk.length,
          sampleSubscriptionIds: chunk.slice(0, 10).map((update) => update.ref.id),
        }, error);
        throw error;
      }
      updated += chunk.length;
    }
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    scanned += snapshot.docs.length;
    console.log(`  Revisadas ${scanned}; reparadas ${updated} suscripción(es)...`);
  }

  console.log(
    `Reparación de nombre de cliente completada. Revisadas: ${scanned}; actualizadas: ${updated}; sin cliente asociado: ${missingClients}.`
  );
}

backfill()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en backfill de nombre de cliente:', error);
    process.exit(1);
  });
