import express, { Request } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { planPageVisitRepository } from '../infrastructure/repositories';
import { adminPageViewsRouter, publicPageViewsRouter } from '../api/routes/page-views';
import { errorHandler } from '../api/middleware/error-handler';

jest.mock('../infrastructure/repositories', () => ({
  planPageVisitRepository: {
    recordIfMissing: jest.fn(),
    listSince: jest.fn(),
  },
}));

const visitsRepository = planPageVisitRepository as unknown as {
  recordIfMissing: jest.Mock;
  listSince: jest.Mock;
};

describe('plan page visit routes', () => {
  let server: Server;
  let baseUrl: string;
  let role: 'admin' | 'super-admin' = 'super-admin';

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as Request & { auth: { role: string } }).auth = { role };
      next();
    });
    app.use('/public/page-views', publicPageViewsRouter);
    app.use('/page-views', adminPageViewsRouter);
    app.use(errorHandler);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    role = 'super-admin';
    visitsRepository.recordIfMissing.mockResolvedValue(true);
    visitsRepository.listSince.mockResolvedValue([]);
  });

  it('records only a daily session hash and coarse referral/device data', async () => {
    const sessionId = 'c0a80123-4567-489a-8abc-123456789abc';
    const response = await fetch(`${baseUrl}/public/page-views`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        referer: 'https://newsletter.example/planes?email=private@example.com',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari/605.1.15',
      },
      body: JSON.stringify({ sessionId, source: 'newsletter', medium: 'email' }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ recorded: true });
    const [visit] = visitsRepository.recordIfMissing.mock.calls[0];
    expect(visit).toMatchObject({
      referrerHost: 'newsletter.example',
      campaignSource: 'newsletter',
      campaignMedium: 'email',
      deviceType: 'mobile',
      browserFamily: 'Safari',
    });
    expect(visit.id).not.toContain(sessionId);
    expect(JSON.stringify(visit)).not.toContain('private@example.com');
    expect(visit).not.toHaveProperty('ip');
    expect(visit).not.toHaveProperty('userAgent');
  });

  it('uses the same daily key when the same browser session reports twice', async () => {
    const sessionId = 'c0a80123-4567-489a-8abc-123456789abc';
    visitsRepository.recordIfMissing
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const collect = () =>
      fetch(`${baseUrl}/public/page-views`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });

    await collect();
    const duplicate = await collect();
    expect(await duplicate.json()).toEqual({ recorded: false });
    expect(visitsRepository.recordIfMissing.mock.calls[0][0].id).toBe(
      visitsRepository.recordIfMissing.mock.calls[1][0].id,
    );
  });

  it('returns aggregated visits and restricts reports to super-admin', async () => {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    visitsRepository.listSince.mockResolvedValue([
      {
        visitedAt: today,
        campaignSource: 'newsletter',
        deviceType: 'mobile',
        browserFamily: 'Safari',
      },
      {
        visitedAt: yesterday,
        referrerHost: 'search.example',
        deviceType: 'desktop',
        browserFamily: 'Chrome',
      },
    ]);

    const response = await fetch(`${baseUrl}/page-views?days=7`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      days: 7,
      totalVisits: 2,
      sources: [
        { label: 'newsletter', visits: 1 },
        { label: 'search.example', visits: 1 },
      ],
      truncated: false,
    });

    role = 'admin';
    const forbidden = await fetch(`${baseUrl}/page-views?days=7`);
    expect(forbidden.status).toBe(403);
  });
});
