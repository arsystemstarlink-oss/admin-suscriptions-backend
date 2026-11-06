import * as firebase from '../infrastructure/firebase';
import { getExpiringWindow } from '../domain/business-rules';
import { SubscriptionFirestoreRepository } from '../infrastructure/repositories';

const makeQuery = (docs: unknown[]) => {
  const query: any = {
    where: jest.fn(function (this: any) { return this; }),
    orderBy: jest.fn(function (this: any) { return this; }),
    startAfter: jest.fn(function (this: any) { return this; }),
    offset: jest.fn(function (this: any) { return this; }),
    limit: jest.fn(function (this: any) { return this; }),
    get: jest.fn().mockResolvedValue({ docs, size: docs.length }),
  };
  jest.spyOn(firebase, 'getFirestore').mockReturnValue({ collection: jest.fn(() => query) } as any);
  return query;
};

const makeDocument = (id: string, endDate: Date) => ({
  id,
  get: (field: string) => (field === 'currentPeriodEndDate' ? endDate : undefined),
  data: () => ({ organizationId: 'org_1', clientId: 'client_1', currentPeriodEndDate: endDate }),
});

describe('filtros de vencimiento de suscripciones', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('la ventana cubre desde el inicio de hoy hasta 7 días después, en UTC', () => {
    const { start, end } = getExpiringWindow(new Date('2026-11-28T23:30:00.000Z'));

    expect(start.toISOString()).toBe('2026-11-28T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-12-05T00:00:00.000Z');
  });

  it('"por vencer" filtra en Firestore, ordena por vencimiento y reanuda desde un cursor de fecha', async () => {
    const window = getExpiringWindow(new Date('2026-11-05T12:00:00.000Z'));
    const first = new Date('2026-11-06T00:00:00.000Z');
    const second = new Date('2026-11-07T00:00:00.000Z');
    const query = makeQuery([
      makeDocument('sub_a', first),
      makeDocument('sub_b', second),
      makeDocument('sub_c', second),
    ]);
    const repository = new SubscriptionFirestoreRepository();

    const page = await repository.listExpiringPage({ organizationId: 'org_1', window, limit: 2 });

    expect(query.where).toHaveBeenCalledWith('status', '==', 'ACTIVE');
    expect(query.where).toHaveBeenCalledWith('currentPeriodStatus', '==', 'PENDING');
    expect(query.where).toHaveBeenCalledWith('currentPeriodEndDate', '>=', window.start);
    expect(query.where).toHaveBeenCalledWith('currentPeriodEndDate', '<=', window.end);
    expect(query.orderBy).toHaveBeenNthCalledWith(1, 'currentPeriodEndDate', 'asc');
    expect(page.items.map((item) => item.id)).toEqual(['sub_a', 'sub_b']);
    expect(page.hasMore).toBe(true);

    await repository.listExpiringPage({
      organizationId: 'org_1',
      window,
      limit: 2,
      cursor: page.nextCursor,
    });

    expect(query.startAfter).toHaveBeenCalledWith(second, 'sub_b');
  });

  it('"pendientes" usa el rango del radar y conserva el orden por nombre', async () => {
    const query = makeQuery([]);
    const repository = new SubscriptionFirestoreRepository();

    await repository.listByClientNamePage({
      organizationId: 'org_1',
      status: 'ACTIVE',
      pendingOnly: true,
      limit: 50,
    });

    expect(query.where).toHaveBeenCalledWith('radarRank', '==', 1);
    expect(query.orderBy).toHaveBeenNthCalledWith(1, 'clientSortName', 'asc');
  });
});
