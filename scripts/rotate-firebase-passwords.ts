/**
 * Reemplaza por valores aleatorios las contraseñas guardadas en Firebase Auth. El login usa el
 * hash de Firestore, así que no afecta a los usuarios; Firebase Auth no permite quitar una
 * contraseña, solo cambiarla. Sin --apply solo cuenta las cuentas y no modifica nada.
 *
 * Uso: npm run rotate:firebase-passwords            (simulación)
 *      npm run rotate:firebase-passwords -- --apply
 */
import crypto from 'crypto';
import dotenv from 'dotenv';
import { initializeFirebase, admin } from '../src/infrastructure/firebase';

dotenv.config();

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  initializeFirebase();

  let total = 0;
  let withPassword = 0;
  let pageToken: string | undefined;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const user of page.users) {
      total++;
      if (!user.providerData.some((provider) => provider.providerId === 'password')) continue;
      withPassword++;
      if (apply) {
        await admin.auth().updateUser(user.uid, { password: crypto.randomBytes(32).toString('base64url') });
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);

  console.log(`Cuentas en Firebase Auth: ${total}. Con contraseña: ${withPassword}.`);
  console.log(apply ? 'Contraseñas reemplazadas.' : 'Simulación: no se modificó nada. Usa --apply para aplicar.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  });
