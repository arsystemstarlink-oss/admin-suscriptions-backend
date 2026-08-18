import dotenv from 'dotenv';
import { initializeFirebase, getFirestore } from '../src/infrastructure/firebase';
import { organizationRepository, userRepository } from '../src/infrastructure/repositories';
import { Organization } from '../src/domain/entities';
import { createId } from '../src/domain/business-rules';

dotenv.config();

const BATCH_SIZE = 400;

function isOrphan(doc: FirebaseFirestore.DocumentSnapshot): boolean {
  return (
    doc.get('organizationId') === undefined ||
    doc.get('organizationId') === null
  );
}

async function validateNoOrphans(): Promise<void> {
  const db = getFirestore();
  const collections = [
    'clients',
    'plans',
    'subscriptions',
    'billingPeriods',
    'whatsappMessages',
    'pushSubscriptions',
  ];

  let orphans = 0;
  for (const collectionName of collections) {
    const snapshot = await db.collection(collectionName).get();
    const orphanDocs = snapshot.docs.filter(isOrphan);
    if (orphanDocs.length > 0) {
      orphans += orphanDocs.length;
      console.error(`  [VALIDACIÓN] ${collectionName}: ${orphanDocs.length} documento(s) sin organizationId.`);
    }
  }

  const usersSnapshot = await db.collection('users').get();
  for (const doc of usersSnapshot.docs) {
    if (doc.get('role') === 'super-admin') continue;
    if (isOrphan(doc)) {
      orphans += 1;
      console.error(`  [VALIDACIÓN] users: ${doc.id} es admin sin organización.`);
    }
  }

  if (orphans > 0) {
    console.error(`\n❌ Migración incompleta: ${orphans} documento(s) huérfano(s).`);
    process.exit(1);
  }
}

async function migrate() {
  try {
    initializeFirebase();

    const args = process.argv.slice(2);
    const promoteToSuperAdmin = args.includes('--promote-super-admin');
    const orgName = process.env.MIGRATE_ORG_NAME || 'Organización Principal';

    console.log('🏢 Iniciando migración multi-tenant...\n');

    let organization = await organizationRepository.getById('org_default');

    if (!organization) {
      const org: Organization = {
        id: 'org_default',
        name: orgName,
        active: true,
        createdAt: new Date(),
      };
      await organizationRepository.create(org);
      organization = org;
      console.log(`✅ Organización creada: ${org.name} (org_default)`);
    } else {
      console.log(`✅ Organización existente: ${organization.name} (org_default)`);
    }

    const db = getFirestore();

    console.log('\n--- Backfill de entidades sin organizationId ---\n');

    let total = 0;

    const collections = ['clients', 'plans', 'subscriptions', 'billingPeriods', 'whatsappMessages', 'pushSubscriptions'];
    for (const collectionName of collections) {
      const snapshot = await db.collection(collectionName).get();
      const docsToUpdate = snapshot.docs.filter(isOrphan);

      if (docsToUpdate.length === 0) {
        console.log(`  [${collectionName}] Sin documentos por migrar.`);
        continue;
      }

      for (let i = 0; i < docsToUpdate.length; i += BATCH_SIZE) {
        const batch = db.batch();
        docsToUpdate.slice(i, i + BATCH_SIZE).forEach((doc) => {
          batch.update(doc.ref, { organizationId: organization.id });
        });
        await batch.commit();
        total += Math.min(BATCH_SIZE, docsToUpdate.length - i);
      }

      console.log(`  [${collectionName}] ${docsToUpdate.length} documento(s) migrado(s).`);
    }

    console.log('\n--- Usuarios ---\n');

    const users = await userRepository.list();

    for (const user of users) {
      if (user.role === 'super-admin') continue;
      if (user.organizationId) continue;

      await db.collection('users').doc(user.id).update({ organizationId: organization.id });
      total++;
      console.log(`  ✅ Usuario ${user.email} asignado a ${organization.name}.`);
    }

    const superAdminCount = users.filter((u) => u.role === 'super-admin').length;

    if (superAdminCount === 0 && promoteToSuperAdmin) {
      const admins = users
        .filter((u) => u.role === 'admin')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      const candidate = admins[0];
      if (candidate) {
        await db.collection('users').doc(candidate.id).update({
          role: 'super-admin',
          organizationId: null,
        });
        console.log(`\n👑 Usuario ${candidate.email} promovido a super-admin (sin organización).`);
      } else {
        console.log('\n⚠️  No hay admins para promover. Crea el super-admin con POST /auth/setup.');
      }
    } else if (superAdminCount === 0) {
      console.log('\n⚠️  No existe un super-admin. Crea el primer usuario con POST /auth/setup');
      console.log('   o ejecuta la migración con --promote-super-admin para promover al primer admin.');
    } else {
      console.log(`\n✅ Super-admin(s) existente(s): ${superAdminCount}.`);
    }

    console.log('\n--- Validación ---\n');
    await validateNoOrphans();

    console.log(`\n🎉 Migración completada. ${total} documento(s) actualizado(s).`);
  } catch (error: any) {
    console.error('\n❌ Error durante la migración:', error.message);
    process.exit(1);
  }
}

migrate();
