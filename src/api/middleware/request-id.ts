import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  res.setHeader('X-Request-ID', requestId);

  try {
    asyncLocalStorage.run({ requestId }, () => next());
  } catch (error) {
    next(error);
  }
}

export function getRequestContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}
