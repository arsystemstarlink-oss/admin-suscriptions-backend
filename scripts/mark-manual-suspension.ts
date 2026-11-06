/**
 * Marca como manual una suspensión anterior al campo `suspensionSource`, para que un pago no
 * la levante. Solo escribe ese campo y solo si la suscripción está suspendida y sin origen.
 *
 * Uso: npm run mark:manual-suspension -- <subscriptionId>
 */
import dotenv from 'dotenv';
import { initializeFirebase, getFirestore } from '../src/infrastructure/firebase';

dotenv.config();

async function main(): Promise<void> {
  const subscriptionId = process.argv[2];
  if (!subscriptionId) {
    throw new Error('Indica el ID de la suscripción.');
  }

  initializeFirebase();
  const db = getFirestore();
  const ref = db.collection('subscriptions').doc(subscriptionId);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data();
    if (!data) throw new Error(`La suscripción ${subscriptionId} no existe.`);
    if (data.status !== 'SUSPENDED') throw new Error(`No está suspendida: su estado es ${data.status}.`);
    if (data.suspensionSource) throw new Error(`Ya tiene origen: ${data.suspensionSource}.`);
    transaction.update(ref, { suspensionSource: 'MANUAL' });
  });

  console.log(`Suscripción ${subscriptionId} marcada como suspensión MANUAL.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('No se aplicó ningún cambio:', (error as Error).message);
    process.exit(1);
  });
