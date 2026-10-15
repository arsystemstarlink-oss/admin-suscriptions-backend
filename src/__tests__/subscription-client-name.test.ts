import * as firebase from '../infrastructure/firebase';
import { getClientNameUpdateFields } from '../domain/business-rules';
import { SubscriptionFirestoreRepository } from '../infrastructure/repositories';

function makeDocument(id: string, clientSortName: string, clientName = clientSortName) {
  return {
    id,
    get: (field: string) => (field === 'clientSortName' ? clientSortName : undefined),
    data: () => ({
      organizationId: 'org_1',
      clientId: 'client_1',
      clientName,
      clientSortName,
    }),
  };
}

describe('client name denormalization', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('backfill helper only returns missing or stale fields, so a repeat is a no-op', () => {
    const expected = { clientName: 'Ana Pérez', clientSortName: 'ana perez' };

    expect(getClientNameUpdateFields(expected, expected)).toBeUndefined();
    expect(
      getClientNameUpdateFields(
        { clientName: 'Ana Pérez', clientSortName: undefined },
        expected
      )
    ).toEqual({ clientSortName: 'ana perez' });
    expect(
      getClientNameUpdateFields(
        { clientName: 'Ana', clientSortName: 'ana' },
        expected
      )
    ).toEqual(expected);
  });

  it('orders subscription pages by clientSortName and resumes from the encoded cursor', async () => {
    const firstPage = [
      makeDocument('sub_a', 'ana'),
      makeDocument('sub_b', 'bruno'),
      makeDocument('sub_c', 'carla'),
    ];
    const secondPage = [makeDocument('sub_c', 'carla')];
    const query: any = {
      where: jest.fn(function (this: any) { return this; }),
      orderBy: jest.fn(function (this: any) { return this; }),
      startAfter: jest.fn(function (this: any) { return this; }),
      offset: jest.fn(function (this: any) { return this; }),
      limit: jest.fn(function (this: any) { return this; }),
      get: jest
        .fn()
        .mockResolvedValueOnce({ docs: firstPage, size: firstPage.length })
        .mockResolvedValueOnce({ docs: secondPage, size: secondPage.length }),
    };
    const db = { collection: jest.fn(() => query) };
    jest.spyOn(firebase, 'getFirestore').mockReturnValue(db as any);

    const repository = new SubscriptionFirestoreRepository();
    const first = await repository.listByClientNamePage({
      organizationId: 'org_1',
      limit: 2,
      requireTotal: false,
    });

    expect(first.items.map((item) => item.id)).toEqual(['sub_a', 'sub_b']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeDefined();
    expect(query.orderBy).toHaveBeenNthCalledWith(1, 'clientSortName', 'asc');

    await repository.listByClientNamePage({
      organizationId: 'org_1',
      limit: 2,
      cursor: first.nextCursor,
      requireTotal: false,
    });

    expect(query.startAfter).toHaveBeenCalledWith('bruno', 'sub_b');
  });

  it('propagates only stale subscriptions and does not write again when rerun', async () => {
    const subscriptions = [
      {
        id: 'sub_current',
        clientName: 'Ana Pérez',
        clientSortName: 'ana perez',
      },
      {
        id: 'sub_stale',
        clientName: 'Ana',
        clientSortName: 'ana',
      },
      {
        id: 'sub_missing',
        clientName: 'Ana Pérez',
      },
    ];
    const update = jest.fn();
    const commit = jest.fn().mockResolvedValue(undefined);
    const query: any = {};
    const batch = { update, commit };
    const db = {
      collection: jest.fn(() => ({
        doc: jest.fn((id: string) => ({ id })),
      })),
      batch: jest.fn(() => batch),
    };
    jest.spyOn(firebase, 'getFirestore').mockReturnValue(db as any);

    const repository = new SubscriptionFirestoreRepository();
    jest.spyOn(repository, 'listByClientId').mockResolvedValue(subscriptions as any);

    const updated = await repository.updateClientNameByClientId(
      'client_1',
      'org_1',
      'Ana Pérez',
      'ana perez'
    );

    expect(updated).toBe(2);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith(
      { id: 'sub_stale' },
      { clientName: 'Ana Pérez', clientSortName: 'ana perez' }
    );
    expect(update).toHaveBeenCalledWith(
      { id: 'sub_missing' },
      { clientSortName: 'ana perez' }
    );

    jest.spyOn(repository, 'listByClientId').mockResolvedValue([
      { id: 'sub_current', clientName: 'Ana Pérez', clientSortName: 'ana perez' },
    ] as any);
    expect(
      await repository.updateClientNameByClientId('client_1', 'org_1', 'Ana Pérez', 'ana perez')
    ).toBe(0);
    expect(db.batch).toHaveBeenCalledTimes(1);
  });
});
