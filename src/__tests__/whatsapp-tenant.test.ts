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

  it('devuelve null cuando la configuración de la organización está desactivada', () => {
    const org = makeOrg({
      accountSid: 'AC_org',
      authToken: 'token_org',
      phoneNumber: '+584111111111',
      enabled: false,
    });

    expect(resolveTwilioCredentials(org)).toBeNull();
  });

  it('devuelve null cuando la configuración de la organización está incompleta', () => {
    const org = makeOrg({ accountSid: 'AC_org' });

    expect(resolveTwilioCredentials(org)).toBeNull();
  });

  it('devuelve null sin organización o sin configuración Twilio', () => {
    expect(resolveTwilioCredentials(undefined)).toBeNull();
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
