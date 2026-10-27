import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { BUSINESS_ERROR_CODES, BUSINESS_ERROR_HTTP_STATUS } from '../domain/error-codes';

function listTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') return [];
      return listTsFiles(full);
    }
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('catálogo de códigos de error', () => {
  it('incluye todos los códigos usados con BusinessError', () => {
    const sourceDir = join(__dirname, '..');
    const codes = new Set<string>();

    for (const file of listTsFiles(sourceDir)) {
      if (file.endsWith('error-codes.ts')) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/new\s+BusinessError\(\s*'([A-Z][A-Z0-9_]+)'/g)) {
        codes.add(match[1]);
      }
    }

    const missing = [...codes].filter((code) => !(code in BUSINESS_ERROR_HTTP_STATUS));
    expect(missing).toEqual([]);
    expect(BUSINESS_ERROR_CODES.length).toBe(Object.keys(BUSINESS_ERROR_HTTP_STATUS).length);
  });
});
