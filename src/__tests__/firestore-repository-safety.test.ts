import { FirestoreRepository } from '../infrastructure/firestore-repository';
import { BusinessError } from '../domain/entities';

class TestRepository extends FirestoreRepository<{ id: string; organizationId: string }> {
  constructor() {
    super('testCollection');
  }
}

describe('FirestoreRepository safety (Fase 1)', () => {
  const repository = new TestRepository();

  it('listByOrganization sin organizationId lanza INVALID_QUERY en vez de list()', async () => {
    await expect(repository.listByOrganization('')).rejects.toThrow(BusinessError);
    await expect(repository.listByOrganization('')).rejects.toThrow(/organizationId/);
  });

  it('listByField con valor undefined lanza INVALID_QUERY en vez de list()', async () => {
    await expect(repository.listByField('organizationId', undefined)).rejects.toThrow(BusinessError);
  });

  it('listByFields sin filtros definidos lanza INVALID_QUERY en vez de list()', async () => {
    await expect(repository.listByFields([])).rejects.toThrow(BusinessError);
    await expect(repository.listByFields([['organizationId', undefined]])).rejects.toThrow(
      BusinessError
    );
  });

  it('listWhere sin límite explícito lanza INVALID_QUERY', async () => {
    await expect(repository.listWhere([])).rejects.toThrow(BusinessError);
  });
});
