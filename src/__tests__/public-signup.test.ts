import {
  buildPaymentInstructions,
  validatePlanQuoteInput,
  validatePublicSignupInput,
} from '../domain/public-signup';

const baseSignup = {
  plan: 'basico',
  organization: { name: 'Mi ISP' },
  admin: {
    name: 'Ana Admin',
    email: 'ANA@Example.com',
    password: 'segura123',
    phone: '0412-1234567',
  },
};

describe('validatePublicSignupInput', () => {
  it('acepta Básico sin datos de pago y normaliza email/teléfono', () => {
    const result = validatePublicSignupInput(baseSignup);
    expect(result.plan).toBe('basico');
    expect(result.organizationName).toBe('Mi ISP');
    expect(result.email).toBe('ana@example.com');
    expect(result.phone).toBe('+584121234567');
    expect(result.payment).toBeUndefined();
  });

  it('exige pago para Pro y solo acepta transferencia o USDT', () => {
    expect(() =>
      validatePublicSignupInput({ ...baseSignup, plan: 'pro' }),
    ).toThrow(/método de pago/i);
    expect(() =>
      validatePublicSignupInput({
        ...baseSignup,
        plan: 'pro',
        payment: { method: 'efectivo', reference: '123' },
      }),
    ).toThrow(/transferencia o USDT/i);
    const result = validatePublicSignupInput({
      ...baseSignup,
      plan: 'negocio',
      payment: { method: 'usdt', reference: 'hash-123', notes: 'ok' },
    });
    expect(result.payment).toEqual({
      method: 'usdt',
      reference: 'hash-123',
      notes: 'ok',
    });
  });

  it('rechaza A medida y contraseñas débiles', () => {
    expect(() =>
      validatePublicSignupInput({ ...baseSignup, plan: 'a-medida' }),
    ).toThrow(/A medida/i);
    expect(() =>
      validatePublicSignupInput({
        ...baseSignup,
        admin: { ...baseSignup.admin, password: 'sololetras' },
      }),
    ).toThrow(/letras y números/i);
  });
});

describe('validatePlanQuoteInput', () => {
  it('normaliza una solicitud válida', () => {
    const result = validatePlanQuoteInput({
      name: '  Luis  ',
      email: 'LUIS@Example.com',
      phone: '04141234567',
      organizationName: ' ISP Grande ',
      estimatedClients: '200',
      message: 'Necesito 200 clientes',
    });
    expect(result.name).toBe('Luis');
    expect(result.email).toBe('luis@example.com');
    expect(result.phone).toBe('+584141234567');
    expect(result.estimatedClients).toBe(200);
  });

  it('valida email y cantidad de clientes', () => {
    expect(() => validatePlanQuoteInput({ name: 'Luis', email: 'no', estimatedClients: 10 })).toThrow(
      /email/i,
    );
    expect(() =>
      validatePlanQuoteInput({ name: 'Luis', email: 'luis@example.com', estimatedClients: 0 }),
    ).toThrow(/entero mayor que cero/i);
  });
});

describe('buildPaymentInstructions', () => {
  it('oculta métodos incompletos', () => {
    expect(buildPaymentInstructions({})).toEqual({ bankTransfer: null, usdt: null });
    expect(
      buildPaymentInstructions({
        PAYMENT_BANK_NAME: 'Banco',
        PAYMENT_USDT_NETWORK: 'TRC20',
      }),
    ).toEqual({ bankTransfer: null, usdt: null });
  });

  it('devuelve los bloques configurados con notas opcionales', () => {
    const result = buildPaymentInstructions({
      PAYMENT_BANK_NAME: 'Banco',
      PAYMENT_BANK_ACCOUNT_HOLDER: 'Titular',
      PAYMENT_BANK_ACCOUNT_NUMBER: '0001',
      PAYMENT_BANK_ACCOUNT_TYPE: 'Ahorro',
      PAYMENT_BANK_RIF: 'V-1',
      PAYMENT_BANK_NOTES: 'Enviar comprobante',
      PAYMENT_USDT_NETWORK: 'TRC20',
      PAYMENT_USDT_ADDRESS: 'T123',
    });
    expect(result.bankTransfer).toEqual({
      bankName: 'Banco',
      accountHolder: 'Titular',
      accountNumber: '0001',
      accountType: 'Ahorro',
      rif: 'V-1',
      notes: 'Enviar comprobante',
    });
    expect(result.usdt).toEqual({ network: 'TRC20', address: 'T123', notes: undefined });
  });
});
