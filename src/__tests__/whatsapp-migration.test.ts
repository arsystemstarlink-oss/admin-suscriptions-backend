import { createFakeFirestore } from './support/fake-firestore';
import { OrganizationTwilioConfig } from '../domain/entities';
import { platformWhatsAppRepository } from '../infrastructure/repositories';

jest.mock('../infrastructure/firebase', () => {
  const { createFakeFirestore: create } = jest.requireActual('./support/fake-firestore');
  const fake = create();
  return {
    __fake: fake,
    getFirestore: () => fake.db,
    admin: fake.admin,
  };
});

const fake: ReturnType<typeof createFakeFirestore> = jest.requireMock('../infrastructure/firebase').__fake;
const twilio: OrganizationTwilioConfig = {
  accountSid: `AC${'a'.repeat(32)}`,
  authToken: 'secret-token-1234567',
  phoneNumber: '+584111111111',
  enabled: true,
};
const rules = { reminderDaysBefore: [5], dueDateWarningEnabled: true, suspensionNoticeEnabled: false };

function seedOrganization(templates: Record<string, string> = {}): void {
  fake.seed('organizations', {
    id: 'legacy_org',
    name: 'Mi organización',
    active: true,
    createdAt: new Date(0),
    twilio,
    whatsappNotifications: { rules, templates },
  });
}

describe('migración única de WhatsApp a la plataforma', () => {
  beforeEach(() => {
    fake.clear();
    seedOrganization({ reminder: 'HX_reminder' });
  });

  it('traslada la cuenta, la reserva y las plantillas conservando las reglas y variables antiguas', async () => {
    const result = await platformWhatsAppRepository.migrateOrganizationToPlatform('legacy_org', twilio);

    expect(result.migratedTemplates).toEqual(['reminder']);
    expect(fake.read('organizations', 'legacy_org')).toMatchObject({
      whatsappMode: 'platform',
      whatsappNotifications: { rules, templates: {} },
    });
    expect(fake.read('organizations', 'legacy_org')?.twilio).toBeUndefined();
    expect(fake.read('platform', 'whatsapp')).toMatchObject({
      twilio,
      whatsappNotifications: {
        templates: { reminder: 'HX_reminder' },
        templateModes: { reminder: 'own' },
      },
    });
    expect(fake.read('twilioPhoneNumbers', twilio.phoneNumber!)).toMatchObject({
      organizationId: '__platform__',
    });
  });

  it('permite validar en dry-run sin escribir nada', async () => {
    const result = await platformWhatsAppRepository.migrateOrganizationToPlatform('legacy_org', twilio, false);

    expect(result.migratedTemplates).toEqual(['reminder']);
    expect(fake.read('organizations', 'legacy_org')?.twilio).toEqual(twilio);
    expect(fake.read('organizations', 'legacy_org')?.whatsappMode).toBeUndefined();
    expect(fake.read('platform', 'whatsapp')).toBeUndefined();
    expect(fake.read('twilioPhoneNumbers', twilio.phoneNumber!)).toBeUndefined();
  });

  it('no modifica los datos si ya existe otra cuenta de plataforma', async () => {
    fake.seed('platform', {
      id: 'whatsapp',
      twilio: {
        accountSid: `AC${'b'.repeat(32)}`,
        authToken: 'different-token-123456',
        phoneNumber: '+584000000000',
        enabled: true,
      },
      whatsappNotifications: { rules, templates: {} },
    });

    await expect(
      platformWhatsAppRepository.migrateOrganizationToPlatform('legacy_org', twilio)
    ).rejects.toMatchObject({ code: 'WHATSAPP_PLATFORM_CONFLICT' });

    expect(fake.read('organizations', 'legacy_org')?.twilio).toEqual(twilio);
    expect(fake.read('platform', 'whatsapp')?.twilio?.phoneNumber).toBe('+584000000000');
    expect(fake.read('twilioPhoneNumbers', twilio.phoneNumber!)).toBeUndefined();
  });

  it('no mezcla SID distintos para la misma plantilla', async () => {
    fake.seed('platform', {
      id: 'whatsapp',
      twilio,
      whatsappNotifications: { rules, templates: { reminder: 'HX_platform_reminder' } },
    });

    await expect(
      platformWhatsAppRepository.migrateOrganizationToPlatform('legacy_org', twilio)
    ).rejects.toMatchObject({ code: 'WHATSAPP_PLATFORM_CONFLICT' });

    expect(fake.read('organizations', 'legacy_org')?.twilio).toEqual(twilio);
    expect(fake.read('platform', 'whatsapp')?.whatsappNotifications?.templates.reminder).toBe(
      'HX_platform_reminder'
    );
    expect(fake.read('twilioPhoneNumbers', twilio.phoneNumber!)).toBeUndefined();
  });
});
