import dotenv from 'dotenv';
import { initializeFirebase, getFirestore, admin } from '../src/infrastructure/firebase';

dotenv.config();

const PAGE_SIZE = 500;
const WRITE_BATCH_SIZE = 400;
const APPLY = process.argv.includes('--apply');

/**
 * Crea `twilioPhoneNumbers/{numero}` para las organizaciones que ya tienen un
 * número de WhatsApp de Twilio. Números usados por más de una organización se
 * reportan y no se reservan: deben corregirse manualmente antes de aplicar.
 * Por defecto solo muestra el resultado; usa --apply para escribir.
 */
async function backfill(): Promise<void> {
  initializeFirebase();
  const db = getFirestore();

  const ownersByPhone = new Map<string, string[]>();
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  for (;;) {
    let query = db
      .collection('organizations')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);

    const page = await query.get();
    if (page.empty) break;

    for (const doc of page.docs) {
      const phone = doc.get('twilio.phoneNumber');
      if (typeof phone !== 'string' || !phone) continue;
      const owners = ownersByPhone.get(phone) ?? [];
      owners.push(doc.id);
      ownersByPhone.set(phone, owners);
    }
    lastDoc = page.docs[page.docs.length - 1];
  }

  const conflicts = [...ownersByPhone.entries()].filter(([, owners]) => owners.length > 1);
  const claimable = [...ownersByPhone.entries()].filter(([, owners]) => owners.length === 1);

  for (const [phone, owners] of conflicts) {
    console.warn(`[conflicto] ${phone} usado por: ${owners.join(', ')}`);
  }

  if (!APPLY) {
    console.log(
      `[dry-run] ${claimable.length} números se reservarían, ${conflicts.length} en conflicto. Ejecuta con --apply para escribir.`
    );
    return;
  }

  for (let i = 0; i < claimable.length; i += WRITE_BATCH_SIZE) {
    const batch = db.batch();
    for (const [phone, [organizationId]] of claimable.slice(i, i + WRITE_BATCH_SIZE)) {
      batch.set(
        db.collection('twilioPhoneNumbers').doc(phone),
        { organizationId, updatedAt: new Date() },
        { merge: true }
      );
    }
    await batch.commit();
  }

  console.log(
    `Backfill completado: ${claimable.length} números reservados, ${conflicts.length} en conflicto sin reservar.`
  );
}

backfill().catch((error) => {
  console.error('Error reservando números de Twilio:', error);
  process.exit(1);
});
