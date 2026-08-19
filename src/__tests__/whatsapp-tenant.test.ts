import {
  resolveTwilioCredentials,
  normalizePhoneNumber,
  whatsappService,
} from '../infrastructure/whatsapp-service';
import { Organization } from '../domain/entities';

function makeOrg(twilio?: Organization['twilio']): Organization {
  return {
    id: 'org_test',
    name: 'Test Org',
    active: true,
    twilio,
    createdAt: new Date(),
  };
}

describe('resolveTwilioCredentials', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('usa las credenciales de la organización cuando están completas', () => {
    const org = makeOrg({
      accountSid: 'AC_org',
      authToken: 'token_org',
      phoneNumber: '+584111111111',
    });

    expect(resolveTwilioCredentials(org)).toEqual({
      accountSid: 'AC_org',
      authToken: 'token_org',
      phoneNumber: '+584111111111',
    });
  });

  it('normaliza el prefijo whatsapp: del número de la organización', () => {
    const org = makeOrg({
      accountSid: 'AC_org',
      authToken: 'token_org',
      phoneNumber: 'whatsapp:+584111111111',
    });

    expect(resolveTwilioCredentials(org)?.phoneNumber).toBe('+584111111111');
  });

  it('ignora la configuración de la organización cuando está desactivada', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC_env';
    process.env.TWILIO_AUTH_TOKEN = 'token_env';

    const org = makeOrg({
      accountSid: 'AC_org',
      authToken: 'token_org',
      phoneNumber: '+584111111111',
      enabled: false,
    });

    expect(resolveTwilioCredentials(org)?.accountSid).toBe('AC_env');
  });

  it('ignora la configuración incompleta de la organización y usa env', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC_env';
    process.env.TWILIO_AUTH_TOKEN = 'token_env';

    const org = makeOrg({ accountSid: 'AC_org' });

    expect(resolveTwilioCredentials(org)?.accountSid).toBe('AC_env');
  });

  it('hace fallback a variables de entorno sin organización', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC_env';
    process.env.TWILIO_AUTH_TOKEN = 'token_env';
    process.env.TWILIO_FROM_NUMBER = '+584222222222';

    expect(resolveTwilioCredentials(undefined)).toEqual({
      accountSid: 'AC_env',
      authToken: 'token_env',
      phoneNumber: '+584222222222',
    });
  });

  it('devuelve null cuando no hay credenciales en ningún lado', () => {
    expect(resolveTwilioCredentials(null)).toBeNull();
    expect(resolveTwilioCredentials(makeOrg(undefined))).toBeNull();
  });
});

describe('normalizePhoneNumber', () => {
  it('elimina el prefijo whatsapp: y espacios', () => {
    expect(normalizePhoneNumber(' whatsapp:+584223552626 ')).toBe('+584223552626');
    expect(normalizePhoneNumber('+584223552626')).toBe('+584223552626');
  });
});

describe('parseIncomingMessage', () => {
  it('extrae número de origen y destino sin el prefijo whatsapp:', () => {
    const parsed = whatsappService.parseIncomingMessage({
      From: 'whatsapp:+584120000000',
      To: 'whatsapp:+584223552626',
      Body: 'Hola',
      MessageSid: 'SM123',
      ProfileName: 'Cliente',
    });

    expect(parsed.from).toBe('+584120000000');
    expect(parsed.to).toBe('+584223552626');
    expect(parsed.body).toBe('Hola');
    expect(parsed.messageSid).toBe('SM123');
    expect(parsed.profileName).toBe('Cliente');
  });
});
