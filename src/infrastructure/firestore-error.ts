const GRPC_STATUS_MESSAGE = /^\d+\s+[A-Z][A-Z0-9_]*:/;

export function isFirestoreError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Record<string, unknown>;
  if (candidate.name === 'GoogleError' || candidate.name === 'FirestoreError') {
    return true;
  }
  return typeof candidate.message === 'string' && GRPC_STATUS_MESSAGE.test(candidate.message);
}

export function isFirestoreQuotaError(error: unknown): boolean {
  if (!isFirestoreError(error)) return false;
  const candidate = error as Record<string, unknown>;
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return (
    candidate.code === 8 ||
    /RESOURCE_EXHAUSTED/i.test(message) ||
    /quota exceeded/i.test(message)
  );
}
