import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestMetrics {
  queries: number;
  docReads: number;
  writes: number;
  aggregations: number;
}

export interface RequestContext {
  requestId: string;
  startedAt: number;
  metrics: RequestMetrics;
}

interface RouteMetric {
  requests: number;
  queries: number;
  docReads: number;
  writes: number;
  aggregations: number;
  totalDurationMs: number;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();
const routeMetrics = new Map<string, RouteMetric>();

export function isMetricsEnabled(): boolean {
  return process.env.ENABLE_METRICS === 'true';
}

export function recordQuery(count = 1): void {
  const ctx = asyncLocalStorage.getStore();
  if (ctx) ctx.metrics.queries += count;
}

export function recordDocReads(count = 1): void {
  const ctx = asyncLocalStorage.getStore();
  if (ctx) ctx.metrics.docReads += count;
}

export function recordWrite(count = 1): void {
  const ctx = asyncLocalStorage.getStore();
  if (ctx) ctx.metrics.writes += count;
}

export function recordAggregation(count = 1): void {
  const ctx = asyncLocalStorage.getStore();
  if (ctx) ctx.metrics.aggregations += count;
}

function routeKey(req: Request): string {
  const matched = req.route as { path?: string } | undefined;
  const path = matched?.path ? `${req.baseUrl}${matched.path}` : req.baseUrl || req.path;
  return `${req.method} ${path}`;
}

function recordRoute(key: string, ctx: RequestContext, durationMs: number): void {
  const current =
    routeMetrics.get(key) ||
    { requests: 0, queries: 0, docReads: 0, writes: 0, aggregations: 0, totalDurationMs: 0 };
  current.requests += 1;
  current.queries += ctx.metrics.queries;
  current.docReads += ctx.metrics.docReads;
  current.writes += ctx.metrics.writes;
  current.aggregations += ctx.metrics.aggregations;
  current.totalDurationMs += durationMs;
  routeMetrics.set(key, current);
}

export function getMetricsSnapshot(): Array<RouteMetric & { route: string; avgDurationMs: number }> {
  return [...routeMetrics.entries()]
    .map(([route, metric]) => ({
      route,
      ...metric,
      avgDurationMs: metric.requests > 0 ? Math.round(metric.totalDurationMs / metric.requests) : 0,
    }))
    .sort((a, b) => b.docReads - a.docReads);
}

export function resetMetrics(): void {
  routeMetrics.clear();
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  res.setHeader('X-Request-ID', requestId);

  const ctx: RequestContext = {
    requestId,
    startedAt: Date.now(),
    metrics: { queries: 0, docReads: 0, writes: 0, aggregations: 0 },
  };

  res.on('finish', () => {
    const durationMs = Date.now() - ctx.startedAt;
    recordRoute(routeKey(req), ctx, durationMs);
    if (isMetricsEnabled()) {
      console.log(
        `[metrics] ${JSON.stringify({
          requestId,
          method: req.method,
          route: routeKey(req),
          status: res.statusCode,
          queries: ctx.metrics.queries,
          docReads: ctx.metrics.docReads,
          writes: ctx.metrics.writes,
          aggregations: ctx.metrics.aggregations,
          durationMs,
        })}`
      );
    }
  });

  try {
    asyncLocalStorage.run(ctx, () => next());
  } catch (error) {
    next(error);
  }
}

export function getRequestContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}
