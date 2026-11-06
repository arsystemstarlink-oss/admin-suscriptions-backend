import { FirestoreRepository } from '../infrastructure/firestore-repository';

const DELETE_SENTINEL = { sentinel: 'delete' };
const update = jest.fn(async () => undefined);
const batchUpdate = jest.fn();

jest.mock('../infrastructure/firebase', () => ({
  admin: { firestore: { FieldValue: { delete: () => DELETE_SENTINEL } } },
  getFirestore: () => ({
    collection: () => ({ doc: () => ({ update }) }),
    batch: () => ({ update: batchUpdate, commit: async () => undefined }),
  }),
}));

interface Entity {
  id: string;
  name: string;
  dni?: string;
  nested?: { kept: string; dropped?: string };
}

class TestRepository extends FirestoreRepository<Entity> {
  constructor() {
    super('testCollection');
  }
}

describe('FirestoreRepository: campos en undefined al actualizar', () => {
  const repository = new TestRepository();

  beforeEach(() => jest.clearAllMocks());

  it('update elimina del documento un campo de primer nivel en undefined', async () => {
    await repository.update({ id: 'a', name: 'Ana', dni: undefined });

    expect(update).toHaveBeenCalledWith({ id: 'a', name: 'Ana', dni: DELETE_SENTINEL });
  });

  it('update no toca los campos ausentes de la entidad', async () => {
    await repository.update({ id: 'a', name: 'Ana' });

    expect(update).toHaveBeenCalledWith({ id: 'a', name: 'Ana' });
  });

  it('update omite los undefined anidados, que Firestore no admite', async () => {
    await repository.update({ id: 'a', name: 'Ana', nested: { kept: 'x', dropped: undefined } });

    expect(update).toHaveBeenCalledWith({ id: 'a', name: 'Ana', nested: { kept: 'x' } });
  });

  it('updateMany aplica la misma regla', async () => {
    await repository.updateMany([{ id: 'a', name: 'Ana', dni: undefined }]);

    expect(batchUpdate).toHaveBeenCalledWith(expect.anything(), {
      id: 'a',
      name: 'Ana',
      dni: DELETE_SENTINEL,
    });
  });
});
