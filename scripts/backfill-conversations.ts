import dotenv from 'dotenv';
import { initializeFirebase, getFirestore, admin } from '../src/infrastructure/firebase';
import { WhatsAppMessage } from '../src/domain/entities';
import { WhatsAppConversationFirestoreRepository } from '../src/infrastructure/repositories';

dotenv.config();

const PAGE_SIZE = 500;
const WRITE_BATCH_SIZE = 400;

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

function toDate(value: any): Date {
  if (value instanceof Date) return value;
  if (value?.toDate) return value.toDate();
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

interface ConversationAccumulator {
  id: string;
  organizationId: string;
  phone: string;
  clientId?: string;
  profileName?: string;
  lastMessage: WhatsAppMessage;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

async function backfill(): Promise<void> {
  initializeFirebase();
  const db = getFirestore();

  const conversations = new Map<string, ConversationAccumulator>();
  let processed = 0;
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  for (;;) {
    let query = db
      .collection('whatsappMessages')
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
      const organizationId = data.organizationId;
      const phone = data.phone;
      if (!organizationId || !phone) {
        continue;
      }

      const createdAt = toDate(data.createdAt);
      const message: WhatsAppMessage = {
        id: doc.id,
        organizationId,
        clientId: data.clientId,
        phone,
        direction: data.direction,
        messageSid: data.messageSid,
        body: data.body,
        templateName: data.templateName,
        status: data.status,
        errorMessage: data.errorMessage,
        profileName: data.profileName,
        createdAt,
      };

      const id = WhatsAppConversationFirestoreRepository.docId(organizationId, phone);
      const existing = conversations.get(id);
      if (!existing) {
        conversations.set(id, {
          id,
          organizationId,
          phone,
          clientId: message.clientId,
          profileName: message.profileName,
          lastMessage: message,
          messageCount: 1,
          createdAt,
          updatedAt: createdAt,
        });
        continue;
      }

      existing.messageCount += 1;
      if (createdAt.getTime() >= existing.lastMessage.createdAt.getTime()) {
        existing.lastMessage = message;
        existing.clientId = message.clientId ?? existing.clientId;
        existing.profileName = message.profileName ?? existing.profileName;
        existing.updatedAt = createdAt;
      }
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    processed += snapshot.docs.length;
    console.log(`  Procesados ${processed} mensajes...`);
  }

  const records = [...conversations.values()];
  console.log(`Encontradas ${records.length} conversación(es). Escribiendo...`);

  for (let i = 0; i < records.length; i += WRITE_BATCH_SIZE) {
    const batch = db.batch();
    for (const record of records.slice(i, i + WRITE_BATCH_SIZE)) {
      const { id, ...rest } = record;
      batch.set(db.collection('whatsappConversations').doc(id), stripUndefined(rest));
    }
    await batch.commit();
    console.log(`  Escritas ${Math.min(i + WRITE_BATCH_SIZE, records.length)}/${records.length} conversaciones.`);
  }

  console.log('Backfill de conversaciones completado.');
}

backfill()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en backfill de conversaciones:', error);
    process.exit(1);
  });
