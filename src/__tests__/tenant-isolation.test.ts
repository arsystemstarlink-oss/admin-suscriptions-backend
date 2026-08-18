import { Request } from 'express';
import {
  getEffectiveOrganizationId,
  requireOrganizationId,
  resolveCreateOrganizationId,
  assertResourceInScope,
  getAuth,
} from '../api/middleware/tenant';
import { AuthContext, isAdmin, isSuperAdmin } from '../domain/auth-context';

function makeRequest(overrides?: {
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  auth?: AuthContext;
}): Request {
  return {
    query: overrides?.query || {},
    body: overrides?.body || {},
    auth: overrides?.auth,
  } as unknown as Request;
}

const adminA: AuthContext = { userId: 'user_001', role: 'admin', organizationId: 'org_A' };
const adminWithoutOrg: AuthContext = { userId: 'user_002', role: 'admin', organizationId: null };
const superAdmin: AuthContext = { userId: 'user_000', role: 'super-admin', organizationId: null };

describe('AuthContext', () => {
  it('debería identificar roles correctamente', () => {
    expect(isSuperAdmin(superAdmin)).toBe(true);
    expect(isSuperAdmin(adminA)).toBe(false);
    expect(isAdmin(adminA)).toBe(true);
    expect(isAdmin(superAdmin)).toBe(false);
  });
});

describe('getEffectiveOrganizationId', () => {
  it('debería ignorar el organizationId del query para un admin y usar su org', () => {
    const req = makeRequest({ query: { organizationId: 'org_B' }, auth: adminA });
    expect(getEffectiveOrganizationId(req)).toBe('org_A');
  });

  it('debería usar la org del admin aunque no haya query', () => {
    const req = makeRequest({ auth: adminA });
    expect(getEffectiveOrganizationId(req)).toBe('org_A');
  });

  it('debería permitir a un super-admin filtrar por organización explícita', () => {
    const req = makeRequest({ query: { organizationId: 'org_B' }, auth: superAdmin });
    expect(getEffectiveOrganizationId(req)).toBe('org_B');
  });

  it('debería devolver undefined para un super-admin sin filtro (ver todas)', () => {
    const req = makeRequest({ auth: superAdmin });
    expect(getEffectiveOrganizationId(req)).toBeUndefined();
  });

  it('debería lanzar UNAUTHORIZED sin contexto autenticado', () => {
    const req = makeRequest();
    expect(() => getEffectiveOrganizationId(req)).toThrow('Contexto de autenticación');
  });
});

describe('requireOrganizationId', () => {
  it('debería devolver la org de un admin', () => {
    expect(requireOrganizationId(makeRequest({ auth: adminA }))).toBe('org_A');
  });

  it('debería lanzar TENANT_REQUIRED para super-admin sin filtro', () => {
    expect(() => requireOrganizationId(makeRequest({ auth: superAdmin }))).toThrow(
      'Se requiere un contexto de organización'
    );
  });

  it('debería lanzar TENANT_REQUIRED para admin sin organización', () => {
    expect(() => requireOrganizationId(makeRequest({ auth: adminWithoutOrg }))).toThrow(
      'Se requiere un contexto de organización'
    );
  });
});

describe('resolveCreateOrganizationId', () => {
  it('debería usar la org del admin e ignorar organizationId del body', () => {
    const req = makeRequest({ body: { organizationId: 'org_B' }, auth: adminA });
    expect(resolveCreateOrganizationId(req)).toBe('org_A');
  });

  it('debería exigir organizationId para super-admin', () => {
    expect(() => resolveCreateOrganizationId(makeRequest({ auth: superAdmin }))).toThrow(
      'debe indicar la organización destino'
    );
  });

  it('debería usar el organizationId del body para super-admin', () => {
    const req = makeRequest({ body: { organizationId: 'org_B' }, auth: superAdmin });
    expect(resolveCreateOrganizationId(req)).toBe('org_B');
  });

  it('debería lanzar para admin sin organización', () => {
    expect(() => resolveCreateOrganizationId(makeRequest({ auth: adminWithoutOrg }))).toThrow(
      'Se requiere un contexto de organización'
    );
  });
});

describe('assertResourceInScope', () => {
  it('debería permitir acceso del admin solo a recursos de su org', () => {
    expect(() => assertResourceInScope('org_A', adminA)).not.toThrow();
    expect(() => assertResourceInScope('org_B', adminA)).toThrow('No tienes acceso a este recurso');
  });

  it('debería permitir al super-admin ver cualquier recurso sin filtro', () => {
    expect(() => assertResourceInScope('org_B', superAdmin)).not.toThrow();
  });

  it('debería restringir al super-admin cuando filtra por org', () => {
    expect(() => assertResourceInScope('org_B', superAdmin, 'org_B')).not.toThrow();
    expect(() => assertResourceInScope('org_A', superAdmin, 'org_B')).toThrow('No tienes acceso a este recurso');
  });

  it('debería rechazar recursos sin organización para un admin', () => {
    expect(() => assertResourceInScope(undefined, adminA)).toThrow('No tienes acceso a este recurso');
  });
});

describe('getAuth', () => {
  it('debería devolver el AuthContext', () => {
    expect(getAuth(makeRequest({ auth: adminA }))).toEqual(adminA);
  });

  it('debería lanzar UNAUTHORIZED si no hay contexto', () => {
    expect(() => getAuth(makeRequest())).toThrow('Contexto de autenticación');
  });
});
