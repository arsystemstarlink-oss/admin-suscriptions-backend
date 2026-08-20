import { initializeFirebase, getFirestore, admin } from '../src/infrastructure/firebase';

initializeFirebase();

async function main() {
  const db = getFirestore();
  const orgId = process.argv[2] || 'org_default';
  const ref = db.collection('organizations').doc(orgId);
  const doc = await ref.get();
  if (!doc.exists) {
    console.error(`Organización ${orgId} no existe.`);
    process.exit(1);
  }

  await ref.update({
    'twilio.templateReminder3Days': admin.firestore.FieldValue.delete(),
    'twilio.templateCutoffDay': admin.firestore.FieldValue.delete(),
    'twilio.templateSuspendedNotice': admin.firestore.FieldValue.delete(),
  });

  console.log(`Campos de template eliminados de ${orgId}`);
  const updated = await ref.get();
  console.log(JSON.stringify(updated.data()?.twilio, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
