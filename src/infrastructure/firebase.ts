import admin from 'firebase-admin';
import path from 'path';
import fs from 'fs';

let initialized = false;

export function initializeFirebase(): void {
  if (initialized) return;

  const credJson = process.env.FIREBASE_CREDENTIALS;

  if (credJson) {
    const serviceAccount = JSON.parse(credJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('[Firebase] Inicializado con credenciales desde variable de entorno.');
    initialized = true;
    return;
  }

  const credPath = process.env.FIREBASE_CREDENTIALS_PATH;

  if (credPath && fs.existsSync(credPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('[Firebase] Inicializado con credenciales de servicio.');
  } else {
    const localCred = path.resolve(
      __dirname,
      '../../api-gestion-starlink-firebase-adminsdk-fbsvc-a7cdd010e2.json'
    );

    if (fs.existsSync(localCred)) {
      const serviceAccount = JSON.parse(fs.readFileSync(localCred, 'utf-8'));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log('[Firebase] Inicializado con credenciales locales.');
    } else {
      console.warn('[Firebase] No se encontraron credenciales. Firestore no estará disponible.');
      return;
    }
  }

  initialized = true;
}

export function getFirestore(): admin.firestore.Firestore {
  if (!initialized) {
    throw new Error('Firebase no ha sido inicializado. Llama initializeFirebase() primero.');
  }
  return admin.firestore();
}

export { admin };
