import dotenv from 'dotenv';
import { initializeFirebase, getFirestore, admin } from '../src/infrastructure/firebase';

dotenv.config();

const PAGE_SIZE = 500;
const WRITE_BATCH_SIZE = 400;
const UNREAD_WINDOW_MS = 24 * 60 * 60 * 1000;

function toMillis(value: any): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value._seconds === 'number') return value._seconds * 1000;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

/**
 * Inicializa `hasUnread` en las conversaciones existentes replicando la
 * semántica previa del frontend: sin leer = último mensaje INBOUND dentro de
 * las últimas 24h. Las conversaciones previas sin entrante reciente quedan
 * como leídas para no inflar el badge en el arranque.
 */
async function backfill(): Promise<void> {
  initializeFirebase();
  const db = getFirestore();
  const cutoff = Date.now() - UNREAD_WINDOW_MS;

  let processed = 0;
  let unread = 0;
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  for (;;) {
    let query = db
      .collection('whatsappConversations')
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
      const lastMessage = data?.lastMessage;
      const isRecentInbound =
        lastMessage?.direction === 'INBOUND' && toMillis(lastMessage?.createdAt) >= cutoff;
      const hasUnread = isRecentInbound;
      if (hasUnread) {
        unread += 1;
        batch.update(doc.ref, { hasUnread: true, lastReadAt: null });
      } else {
        batch.update(doc.ref, { hasUnread: false });
      }
    }
    await batch.commit();

    processed += snapshot.docs.length;
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    console.log(`  Procesadas ${processed} conversaciones...`);
  }

  console.log(`Backfill de unread completado. ${processed} conversaciones, ${unread} sin leer.`);
}

backfill()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en backfill de unread:', error);
    process.exit(1);
  });
