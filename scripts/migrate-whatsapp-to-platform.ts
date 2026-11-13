import dotenv from 'dotenv';
import { admin, initializeFirebase } from '../src/infrastructure/firebase';
import { organizationRepository, platformWhatsAppRepository } from '../src/infrastructure/repositories';
import {
  extractTwilioError,
  resolveTwilioCredentials,
  whatsappService,
} from '../src/infrastructure/whatsapp-service';

dotenv.config();

async function migrate(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const options = args.filter((arg) => arg.startsWith('--'));
  const organizationIds = args.filter((arg) => !arg.startsWith('--'));
  if (options.some((option) => option !== '--apply') || organizationIds.length !== 1) {
    throw new Error('Uso: npm run migrate:whatsapp-to-platform -- <organizationId> [--apply]');
  }

  initializeFirebase();
  console.log(`Proyecto Firebase: ${admin.app().options.projectId ?? 'no identificado'}.`);
  const organizationId = organizationIds[0];
  const organization = await organizationRepository.getById(organizationId);
  if (!organization) {
    throw new Error(`No existe la organización "${organizationId}".`);
  }
  const missingTwilioFields = [
    !organization.twilio?.accountSid?.trim() ? 'twilio.accountSid' : undefined,
    !organization.twilio?.authToken?.trim() ? 'twilio.authToken' : undefined,
    !organization.twilio?.phoneNumber?.trim() ? 'twilio.phoneNumber' : undefined,
    organization.twilio?.enabled === false ? 'twilio.enabled está deshabilitado' : undefined,
  ].filter((field): field is string => Boolean(field));
  if (missingTwilioFields.length > 0) {
    throw new Error(
      `La organización no tiene Twilio listo en este proyecto. Revisa: ${missingTwilioFields.join(', ')}.`
    );
  }
  const credentials = resolveTwilioCredentials(organization);
  if (!credentials || !organization.twilio) {
    throw new Error('No se pudieron resolver credenciales Twilio completas y habilitadas.');
  }

  try {
    await whatsappService.verifyAccount(credentials);
  } catch (error) {
    const twilioError = extractTwilioError(error);
    throw new Error(
      twilioError
        ? `Twilio rechazó las credenciales (código ${twilioError.code}); no se realizaron cambios.`
        : 'No se pudieron verificar las credenciales con Twilio; no se realizaron cambios.'
    );
  }

  const result = await platformWhatsAppRepository.migrateOrganizationToPlatform(
    organizationId,
    organization.twilio,
    apply
  );
  const templateSummary = result.migratedTemplates.length
    ? result.migratedTemplates.join(', ')
    : 'ninguna';

  if (apply) {
    console.log(`Migración aplicada para "${organizationId}".`);
    console.log(`Plantillas transferidas: ${templateSummary}.`);
    console.log('La organización ya usa el WhatsApp de la plataforma.');
    return;
  }

  console.log(`[dry-run] Migración validada para "${organizationId}".`);
  console.log(`Plantillas que se transferirían: ${templateSummary}.`);
  console.log('No se escribió ningún cambio. Añade --apply para ejecutar la migración.');
}

migrate().catch((error: unknown) => {
  console.error(
    'No se pudo migrar WhatsApp a la plataforma:',
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
