import { Request, Response } from 'express';
import {
  ProgressiveDniLimiter,
  createCaptchaVerifier,
  createDniRateLimiter,
} from '../api/middleware/public-protection';

function mockResponse() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    headers: Record<string, string>;
    body: { error: { code: string } };
  };
}

describe('ProgressiveDniLimiter', () => {
  const build = () =>
    new ProgressiveDniLimiter({
      windowMs: 10_000,
      maxAttempts: 3,
      baseBlockMs: 1_000,
      maxBlockMs: 8_000,
    });

  it('permite hasta el máximo de intentos dentro de la ventana', () => {
    const limiter = build();
    expect(limiter.check('a', 0).allowed).toBe(true);
    expect(limiter.check('a', 1).allowed).toBe(true);
    expect(limiter.check('a', 2).allowed).toBe(true);
  });

  it('bloquea al superar el máximo y expone el tiempo de espera', () => {
    const limiter = build();
    for (let i = 0; i < 3; i++) limiter.check('a', i);
    const blocked = limiter.check('a', 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1_000);
    expect(blocked.strike).toBe(1);
  });

  it('mantiene el bloqueo hasta que expira', () => {
    const limiter = build();
    for (let i = 0; i < 4; i++) limiter.check('a', i);
    expect(limiter.check('a', 500).allowed).toBe(false);
    expect(limiter.check('a', 1_004).allowed).toBe(true);
  });

  it('duplica el bloqueo en reincidencias', () => {
    const limiter = build();
    for (let i = 0; i < 4; i++) limiter.check('a', i); // strike 1: bloqueo 1000
    for (let i = 0; i < 3; i++) limiter.check('a', 2_000 + i);
    const second = limiter.check('a', 2_003);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBe(2_000);
    expect(second.strike).toBe(2);
  });

  it('deca el nivel tras una ventana sin infracciones', () => {
    const limiter = build();
    for (let i = 0; i < 4; i++) limiter.check('a', i); // strike 1
    const later = 100_000;
    limiter.check('a', later); // decae a strike 0
    for (let i = 1; i < 3; i++) limiter.check('a', later + i);
    const violation = limiter.check('a', later + 3);
    expect(violation.strike).toBe(1);
  });

  it('aísla el conteo entre claves distintas', () => {
    const limiter = build();
    for (let i = 0; i < 4; i++) limiter.check('a', i);
    expect(limiter.check('b', 4).allowed).toBe(true);
  });
});

describe('createDniRateLimiter', () => {
  it('responde 429 con Retry-After al bloquear una cédula', () => {
    const limiter = new ProgressiveDniLimiter({ maxAttempts: 1, baseBlockMs: 5_000, windowMs: 60_000 });
    const middleware = createDniRateLimiter(limiter);
    const req = { params: { slug: 'org' }, body: { dni: 'V-12345678' }, ip: '1.2.3.4' } as unknown as Request;

    const res1 = mockResponse();
    const next1 = jest.fn();
    middleware(req, res1, next1);
    expect(next1).toHaveBeenCalled();

    const res2 = mockResponse();
    const next2 = jest.fn();
    middleware(req, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(429);
    expect(res2.headers['Retry-After']).toBe('5');
    expect(res2.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('createCaptchaVerifier', () => {
  const originalSecret = process.env.TURNSTILE_SECRET_KEY;
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env.TURNSTILE_SECRET_KEY = originalSecret;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const run = async (body: Record<string, unknown>) => {
    const middleware = createCaptchaVerifier({ action: 'public_consulta' });
    const req = { body, ip: '1.2.3.4' } as unknown as Request;
    const res = mockResponse();
    const next = jest.fn();
    await middleware(req, res, next as never);
    return { res, next };
  };

  it('omite la verificación si no hay secreto configurado', async () => {
    process.env.TURNSTILE_SECRET_KEY = '';
    const { next, res } = await run({});
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
  });

  it('rechaza cuando falta el token', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    const { next, res } = await run({});
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('CAPTCHA_REQUIRED');
  });

  it('acepta un token válido con la acción esperada', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ success: true, action: 'public_consulta' }),
    }) as unknown as typeof fetch;
    const { next, res } = await run({ turnstileToken: 'tok' });
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
  });

  it('rechaza un token inválido', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
    }) as unknown as typeof fetch;
    const { next, res } = await run({ turnstileToken: 'tok' });
    expect(next).not.toHaveBeenCalled();
    expect(res.body.error.code).toBe('CAPTCHA_FAILED');
  });

  it('rechaza cuando la acción no coincide', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ success: true, action: 'otra_accion' }),
    }) as unknown as typeof fetch;
    const { next, res } = await run({ turnstileToken: 'tok' });
    expect(next).not.toHaveBeenCalled();
    expect(res.body.error.code).toBe('CAPTCHA_FAILED');
  });

  it('responde 503 si falla la verificación remota', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    global.fetch = jest.fn().mockRejectedValue(new Error('network')) as unknown as typeof fetch;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { next, res } = await run({ turnstileToken: 'tok' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('CAPTCHA_UNAVAILABLE');
  });
});
