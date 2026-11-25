import { createHash } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { BusinessError, PlanPageVisit } from '../../domain/entities';
import { planPageVisitRepository } from '../../infrastructure/repositories';
import { requireSuperAdmin } from '../middleware/auth';

export const publicPageViewsRouter = Router();
const adminPageViewsRouter = Router();
const VISIT_RETENTION_DAYS = 90;
const REPORT_LIMIT = 5000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT_WINDOWS = [7, 30, 90] as const;

function optionalCampaignValue(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new BusinessError('INVALID_DATA', `El campo ${field} no es válido.`);
  }
  const cleaned = value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100);
  return cleaned || undefined;
}

function getReferrerHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname.slice(0, 253) || undefined;
  } catch {
    return undefined;
  }
}

function getDeviceType(userAgent: string): PlanPageVisit['deviceType'] {
  if (/ipad|tablet/i.test(userAgent)) return 'tablet';
  if (/mobile|android|iphone|ipod/i.test(userAgent)) return 'mobile';
  return 'desktop';
}

function getBrowserFamily(userAgent: string): PlanPageVisit['browserFamily'] {
  if (/edg\//i.test(userAgent)) return 'Edge';
  if (/firefox\//i.test(userAgent)) return 'Firefox';
  if (/chrome\//i.test(userAgent) || /chromium\//i.test(userAgent)) return 'Chrome';
  if (/safari\//i.test(userAgent)) return 'Safari';
  return 'Other';
}

function addCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function toBreakdown(counts: Map<string, number>) {
  return [...counts.entries()]
    .map(([label, visits]) => ({ label, visits }))
    .sort((a, b) => b.visits - a.visits || a.label.localeCompare(b.label))
    .slice(0, 10);
}

publicPageViewsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.body?.sessionId;
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new BusinessError('INVALID_DATA', 'La sesión de visita no es válida.');
    }

    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const sessionHash = createHash('sha256').update(`${day}:${sessionId}`).digest('hex');
    const visit: PlanPageVisit = {
      id: `${day}_${sessionHash}`,
      visitedAt: now,
      expiresAt: new Date(now.getTime() + VISIT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
      referrerHost: getReferrerHost(req.get('referer')),
      campaignSource: optionalCampaignValue(req.body?.source, 'source'),
      campaignMedium: optionalCampaignValue(req.body?.medium, 'medium'),
      campaignName: optionalCampaignValue(req.body?.campaign, 'campaign'),
      deviceType: getDeviceType(req.get('user-agent') ?? ''),
      browserFamily: getBrowserFamily(req.get('user-agent') ?? ''),
    };

    const recorded = await planPageVisitRepository.recordIfMissing(visit);
    res.status(202).json({ recorded });
  } catch (error) {
    next(error);
  }
});

adminPageViewsRouter.use(requireSuperAdmin);

adminPageViewsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = Number(req.query.days ?? 30);
    if (!REPORT_WINDOWS.includes(days as (typeof REPORT_WINDOWS)[number])) {
      throw new BusinessError('INVALID_FILTER', 'El período debe ser de 7, 30 o 90 días.');
    }

    const now = new Date();
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - days + 1);

    const visits = await planPageVisitRepository.listSince(start, REPORT_LIMIT);
    const dailyCounts = new Map<string, number>();
    const sourceCounts = new Map<string, number>();
    const campaignCounts = new Map<string, number>();
    const deviceCounts = new Map<string, number>();
    const browserCounts = new Map<string, number>();

    visits.forEach((visit) => {
      const date = visit.visitedAt.toISOString().slice(0, 10);
      addCount(dailyCounts, date);
      const source = visit.campaignSource
        ? `${visit.campaignSource}${visit.campaignMedium ? ` / ${visit.campaignMedium}` : ''}`
        : visit.referrerHost || 'Directo';
      addCount(sourceCounts, source);
      if (visit.campaignName) addCount(campaignCounts, visit.campaignName);
      addCount(deviceCounts, visit.deviceType);
      addCount(browserCounts, visit.browserFamily);
    });

    const daily = Array.from({ length: days }, (_, index) => {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + index);
      const key = date.toISOString().slice(0, 10);
      return { date: key, visits: dailyCounts.get(key) ?? 0 };
    });

    res.json({
      days,
      totalVisits: visits.length,
      daily,
      sources: toBreakdown(sourceCounts),
      campaigns: toBreakdown(campaignCounts),
      devices: toBreakdown(deviceCounts),
      browsers: toBreakdown(browserCounts),
      truncated: visits.length === REPORT_LIMIT,
    });
  } catch (error) {
    next(error);
  }
});

export { adminPageViewsRouter };
