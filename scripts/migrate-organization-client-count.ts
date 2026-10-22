import dotenv from 'dotenv';
import { admin, getFirestore, initializeFirebase } from '../src/infrastructure/firebase';

dotenv.config();

const PAGE_SIZE = 300;

async function migrate(): Promise<void> {
  initializeFirebase();
  const db = getFirestore();
  let lastOrganization: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let organizationsUpdated = 0;

  for (;;) {
    let query = db
      .collection('organizations')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (lastOrganization) query = query.startAfter(lastOrganization);

    const page = await query.get();
    if (page.empty) break;

    for (const organization of page.docs) {
      const countSnapshot = await db
        .collection('clients')
        .where('organizationId', '==', organization.id)
        .count()
        .get();
      await organization.ref.update({ clientCount: countSnapshot.data().count });
      organizationsUpdated++;
      console.log(`[clientCount] ${organization.id}: ${countSnapshot.data().count}`);
    }

    lastOrganization = page.docs[page.docs.length - 1];
  }

  console.log(`Migración completada: ${organizationsUpdated} organizaciones actualizadas.`);
}

migrate().catch((error) => {
  console.error('Error migrando el contador de clientes:', error);
  process.exit(1);
});
