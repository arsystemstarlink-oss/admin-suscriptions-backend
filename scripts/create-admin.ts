import dotenv from 'dotenv';
import { initializeFirebase, admin, syncUserCustomClaims } from '../src/infrastructure/firebase';
import { userRepository } from '../src/infrastructure/repositories';
import { authService } from '../src/domain/auth-service';
import { User } from '../src/domain/entities';
import { createId } from '../src/domain/business-rules';

dotenv.config();

async function createAdmin() {
  try {
    console.log('🔐 Creando usuario administrador...\n');

    initializeFirebase();

    const args = process.argv.slice(2);
    const name = args[0] || 'Admin';
    const email = args[1] || 'admin@example.com';
    const password = args[2];
    const phone = args[3];
    const role = args.includes('--super-admin') ? 'super-admin' : 'admin';
    const organizationId = args.find((a) => a.startsWith('--org='))?.split('=')[1] || 'org_default';

    if (!password) {
      console.error('❌ Error: Debes proporcionar una contraseña.');
      console.log('\n📝 Uso:');
      console.log('   npm run create-admin "Nombre" email@example.com "tu-contraseña" "teléfono(opcional)" [--super-admin] [--org=org_default]');
      process.exit(1);
    }

    if (password.length < 8) {
      console.error('❌ Error: La contraseña debe tener al menos 8 caracteres.');
      process.exit(1);
    }

    const existingUser = await userRepository.findByEmail(email);

    if (existingUser) {
      console.log('⚠️  Ya existe un usuario con ese email:');
      console.log(`   ID: ${existingUser.id}`);
      console.log(`   Nombre: ${existingUser.name}`);
      console.log(`   Email: ${existingUser.email}`);
      console.log(`   Rol: ${existingUser.role}\n`);
      console.log('💡 Si olvidaste la contraseña, crea un nuevo usuario con otro email.');
      return;
    }

    const userId = createId();
    const hashedPassword = await authService.hashPassword(password);

    const adminUser: User = {
      id: userId,
      name,
      email,
      password: hashedPassword,
      role: role === 'super-admin' ? 'super-admin' : 'admin',
      organizationId: role === 'super-admin' ? null : organizationId,
      phone,
      createdAt: new Date(),
    };

    await userRepository.create(adminUser);

    try {
      await admin.auth().createUser({
        uid: userId,
        email,
        password,
        displayName: name,
      });
      console.log('✅ Usuario creado en Firebase Auth (respaldo de seguridad)\n');
    } catch (firebaseError: any) {
      if (firebaseError.code === 'auth/email-already-exists') {
        console.log('⚠️  Email ya existe en Firebase Auth (continuando...)\n');
      } else {
        console.log('⚠️  No se pudo crear en Firebase Auth:', firebaseError.message);
        console.log('   El usuario está guardado en Firestore correctamente.\n');
      }
    }

    await syncUserCustomClaims({
      uid: adminUser.id,
      role: adminUser.role,
      organizationId: adminUser.organizationId,
    });

    console.log('✅ Usuario administrador creado exitosamente:\n');
    console.log(`   ID: ${adminUser.id}`);
    console.log(`   Nombre: ${adminUser.name}`);
    console.log(`   Email: ${adminUser.email}`);
    if (adminUser.phone) {
      console.log(`   Teléfono: ${adminUser.phone}`);
    }
    console.log(`   Rol: ${adminUser.role}`);
    if (adminUser.organizationId) {
      console.log(`   Organización: ${adminUser.organizationId}`);
    }
    console.log(`   Creado: ${adminUser.createdAt.toISOString()}\n`);

    console.log('🔑 Generando tokens JWT para pruebas...\n');
    const accessToken = authService.generateAccessToken(adminUser);
    const refresh = authService.generateRefreshToken(adminUser);

    console.log('✅ Tokens generados:\n');
    console.log('Access Token (15 min):');
    console.log(accessToken);
    console.log('\nRefresh Token (7 días):');
    console.log(refresh.token);
    console.log('\n📝 Uso en Postman:');
    console.log('   Header: Authorization');
    console.log(`   Value:  Bearer ${accessToken}\n`);
    console.log('💡 También puedes hacer login con:');
  } catch (error: any) {
    console.error('❌ Error creando administrador:', error.message);
    process.exit(1);
  }
}

createAdmin();
