import dotenv from 'dotenv';
import { initializeFirebase, getFirestore } from '../src/infrastructure/firebase';
import { persistOrganizationStats } from '../src/infrastructure/stats-service';

dotenv.config();

async function rebuild(): Promise<void> {
  initializeFirebase();
  const db = getFirestore();

  const explicitOrgId = process.argv[2];
  let organizationIds: string[];

  if (explicitOrgId) {
    organizationIds = [explicitOrgId];
  } else {
    const snapshot = await db.collection('organizations').get();
    organizationIds = snapshot.docs.map((doc) => doc.id);
  }

  if (organizationIds.length === 0) {
    console.log('No hay organizaciones para reconstruir.');
    return;
  }

  for (const organizationId of organizationIds) {
    try {
      const stats = await persistOrganizationStats(organizationId);
      console.log(
        `[rebuild:stats] org ${organizationId}: clients=${stats.clients.total} subs=${stats.subscriptions.active}/${stats.subscriptions.total} pendientes=${stats.billingPeriods.pending} vencidos=${stats.billingPeriods.overdue}`
      );
    } catch (error) {
      console.error(`[rebuild:stats] Error en org ${organizationId}:`, error);
    }
  }

  console.log(`Reconstrucción de organizationStats completada para ${organizationIds.length} organización(es).`);
}

rebuild()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error reconstruyendo organizationStats:', error);
    process.exit(1);
  });
