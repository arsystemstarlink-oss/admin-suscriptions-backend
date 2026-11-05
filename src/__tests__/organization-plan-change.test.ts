import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { Organization } from '../domain/entities';
import {
  organizationPlanPaymentReportRepository,
  organizationRepository,
  userRepository,
} from '../infrastructure/repositories';
import router from '../api/routes/organization-plan-payment-reports';
import { errorHandler } from '../api/middleware/error-handler';

jest.mock('../infrastructure/repositories', () => ({
  organizationRepository: {
    getById: jest.fn(),
    refreshExpiredStatus: jest.fn(),
    listByIds: jest.fn(),
    registerPlanPayment: jest.fn(),
  },
  organizationPlanPaymentReportRepository: {
    findPendingByOrganization: jest.fn(),
    create: jest.fn(),
    getById: jest.fn(),
    update: jest.fn(),
  },
  userRepository: {
    listByOrganization: jest.fn(),
  },
}));
jest.mock('../infrastructure/push-service', () => ({
  pushService: { sendBroadcastToOrganization: jest.fn(() => Promise.resolve()) },
}));
jest.mock('../api/middleware/auth', () => ({
  requireSuperAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const organizations = organizationRepository as unknown as {
  getById: jest.Mock;
  refreshExpiredStatus: jest.Mock;
  registerPlanPayment: jest.Mock;
};
const reports = organizationPlanPaymentReportRepository as unknown as {
  findPendingByOrganization: jest.Mock;
  create: jest.Mock;
  getById: jest.Mock;
  update: jest.Mock;
};
const users = userRepository as unknown as { listByOrganization: jest.Mock };

const REMAINING_DAYS = 100;
// (40 - 25) USD × 100 días ÷ (365 / 12)
const DIFFERENCE = 49.32;

const today = new Date();
const paidAt = today.toISOString().slice(0, 10);
const expiry = new Date(
  Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate() + REMAINING_DAYS,
    23,
    59,
    59,
    999
  )
);

const proOrganization: Organization = {
  id: 'org_1',
  name: 'Org',
  active: true,
  plan: 'pro',
  clientLimit: 75,
  planStatus: 'activo',
  billingDay: expiry.getUTCDate() > 28 ? 28 : expiry.getUTCDate(),
  trialEndsAt: null,
  planExpiresAt: expiry,
  clientCount: 10,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('organization plan change routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as Request & { auth: unknown }).auth = {
        userId: 'user_1',
        role: 'admin',
        organizationId: 'org_1',
      };
      next();
    });
    app.use('/reports', router);
    app.use(errorHandler);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/reports`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    organizations.getById.mockResolvedValue(proOrganization);
    organizations.refreshExpiredStatus.mockImplementation(async (organization) => organization);
    reports.findPendingByOrganization.mockResolvedValue(null);
    reports.create.mockResolvedValue(undefined);
    users.listByOrganization.mockResolvedValue([]);
  });

  const quote = async (plan: string) => {
    const response = await fetch(`${baseUrl}/quote?plan=${plan}&paidAt=${paidAt}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { quote: any }).quote;
  };

  const report = (body: Record<string, unknown>) =>
    fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'usdt', paidAt, ...body }),
    });

  it('quotes an upgrade with the difference and without losing the paid term', async () => {
    const result = await quote('negocio');

    expect(result.planChanged).toBe(true);
    expect(result.planDifferenceAmount).toBe(DIFFERENCE);
    expect(result.expirations[0]).toMatchObject({
      months: 0,
      amount: DIFFERENCE,
      newPlanExpiresAt: expiry.toISOString(),
      exceedsPrepaidLimit: false,
    });
    expect(result.expirations[1]).toMatchObject({ months: 1, amount: 89.32 });
    expect(new Date(result.expirations[1].newPlanExpiresAt).getTime()).toBeGreaterThan(
      expiry.getTime()
    );
  });

  it('quotes a renewal without difference or a difference-only option', async () => {
    const result = await quote('pro');

    expect(result.planDifferenceAmount).toBe(0);
    expect(result.expirations[0]).toMatchObject({ months: 1, amount: 25 });
    expect(result.expirations.some((option: { months: number }) => option.months === 0)).toBe(false);
  });

  it('stores the server amount when reporting only the difference', async () => {
    const response = await report({ plan: 'negocio', months: 0, amount: 1 });

    expect(response.status).toBe(201);
    expect(reports.create).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'negocio', months: 0, amount: DIFFERENCE })
    );
  });

  it('rejects zero months when the plan stays the same', async () => {
    const response = await report({ plan: 'pro', months: 0 });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('INVALID_PLAN_MONTHS');
    expect(reports.create).not.toHaveBeenCalled();
  });

  it('quotes a lapsed plan from the payment day with a full month', async () => {
    organizations.getById.mockResolvedValue({
      ...proOrganization,
      planStatus: 'vencido',
      planExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const result = await quote('pro');
    const days =
      (new Date(result.expirations[0].newPlanExpiresAt).getTime() - Date.now()) /
      (24 * 60 * 60 * 1000);

    expect(result.billingDay).toBe(Math.min(today.getUTCDate(), 28));
    expect(result.expirations[0]).toMatchObject({ months: 1, amount: 25 });
    expect(days).toBeGreaterThanOrEqual(27);
    expect(result.expirations.find((option: { months: number }) => option.months === 12)).toMatchObject({
      exceedsPrepaidLimit: false,
    });
  });

  describe('during an active trial', () => {
    const trialEnd = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 10, 12)
    );
    const trialDay = Math.min(trialEnd.getUTCDate(), 28);
    const signupDay = trialDay === 1 ? 2 : trialDay - 1;

    beforeEach(() => {
      organizations.getById.mockResolvedValue({
        ...proOrganization,
        plan: 'basico',
        clientLimit: 30,
        planStatus: 'prueba',
        billingDay: signupDay,
        trialEndsAt: trialEnd,
        planExpiresAt: null,
      });
      organizations.registerPlanPayment.mockImplementation(async (payment) => ({ id: payment.organizationId }));
      reports.update.mockResolvedValue(undefined);
    });

    const review = async (signupPayment?: boolean) => {
      reports.getById.mockResolvedValue({
        id: 'report_1',
        organizationId: 'org_1',
        plan: 'pro',
        amount: 25,
        method: 'usdt',
        paidAt: today,
        months: 1,
        clientLimit: 75,
        signupPayment,
        status: 'PENDING',
        createdAt: today,
        createdByUserId: 'user_1',
      });
      const response = await fetch(`${baseUrl}/report_1/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      });
      expect(response.status).toBe(200);
      return organizations.registerPlanPayment.mock.calls[0];
    };

    it('quotes twelve months from the end of the trial without exceeding the limit', async () => {
      const result = await quote('basico');

      expect(result.billingDay).toBe(trialDay);
      expect(result.expirations.find((option: { months: number }) => option.months === 12)).toMatchObject({
        exceedsPrepaidLimit: false,
      });
    });

    it('moves the billing day when approving a payment made during the trial', async () => {
      const [, , , , billingDay] = await review();

      expect(billingDay).toBe(trialDay);
    });

    it('keeps the signup billing day when approving a signup payment', async () => {
      const [, , , , billingDay] = await review(true);

      expect(billingDay).toBe(signupDay);
    });
  });

  it('keeps blocking downgrades while the term is active', async () => {
    const response = await report({ plan: 'basico', months: 1 });

    expect(response.status).toBe(409);
    expect(await response.text()).toContain('PLAN_DOWNGRADE_NOT_ALLOWED');
    expect(reports.create).not.toHaveBeenCalled();
  });
});
