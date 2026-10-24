import * as firebase from '../infrastructure/firebase';
import { OrganizationFirestoreRepository } from '../infrastructure/repositories';
import { Organization } from '../domain/entities';

type Writes = Array<[string, string, unknown?]>;

function makeOrg(id: string, phoneNumber?: string): Organization {
  return {
    id,
    name: id.toUpperCase(),
    active: true,
    twilio: phoneNumber ? { accountSid: 'AC1', authToken: 'tok', phoneNumber, enabled: true } : undefined,
    createdAt: new Date(0),
  } as Organization;
}

function createFakeDb(seed: {
  organizations: Organization[];
  claims?: Record<string, string>;
}) {
  const orgs = new Map(seed.organizations.map((org) => [org.id, org]));
  const claims = new Map(Object.entries(seed.claims ?? {}));
  const writes: Writes = [];

  const docSnapshot = (collection: string, id: string) => {
    const data =
      collection === 'organizations'
        ? orgs.get(id)
        : claims.has(id)
          ? { organizationId: claims.get(id) }
          : undefined;
    return { id, exists: data !== undefined, data: () => data, ref: { collection, id } };
  };

  const querySnapshot = (field: string, value: string) => {
    const docs = [...orgs.values()]
      .filter((org) => field === 'twilio.phoneNumber' && org.twilio?.phoneNumber === value)
      .map((org) => ({ id: org.id, exists: true, data: () => org, ref: { collection: 'organizations', id: org.id } }));
    return { docs, size: docs.length, empty: docs.length === 0 };
  };

  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({ collection: name, id, path: `${name}/${id}` }),
      where: (field: string, _op: string, value: string) => ({ __query: true, field, value }),
    }),
    runTransaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async (target: any) =>
          target.__query
            ? querySnapshot(target.field, target.value)
            : docSnapshot(target.collection, target.id),
        set: (ref: any, data: unknown) => writes.push(['set', ref.path, data]),
        create: (ref: any, data: unknown) => writes.push(['create', ref.path, data]),
        update: (ref: any, data: unknown) => writes.push(['update', ref.path, data]),
        delete: (ref: any) => writes.push(['delete', ref.path]),
      };
      return callback(tx);
    },
  };

  return { db, writes };
}

describe('Twilio phone number uniqueness across organizations', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a number reserved by another organization without writing', async () => {
    const { db, writes } = createFakeDb({
      organizations: [makeOrg('org_a', '+584111111111'), makeOrg('org_b')],
      claims: { '+584111111111': 'org_a' },
    });
    jest.spyOn(firebase, 'getFirestore').mockReturnValue(db as any);
    const repo = new OrganizationFirestoreRepository();

    await expect(
      repo.updateWhatsAppConfiguration(
        'org_b',
        { accountSid: 'AC2', authToken: 'tok2', phoneNumber: '+584111111111', enabled: true },
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'TWILIO_NUMBER_IN_USE' });
    expect(writes).toEqual([]);
  });

  it('rejects a number already used by another organization without a claim (legacy data)', async () => {
    const { db, writes } = createFakeDb({
      organizations: [makeOrg('org_a', '+584111111111'), makeOrg('org_b')],
    });
    jest.spyOn(firebase, 'getFirestore').mockReturnValue(db as any);
    const repo = new OrganizationFirestoreRepository();

    await expect(
      repo.updateWhatsAppConfiguration(
        'org_b',
        { accountSid: 'AC2', authToken: 'tok2', phoneNumber: '+584111111111', enabled: true },
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'TWILIO_NUMBER_IN_USE' });
    expect(writes).toEqual([]);
  });

  it('reserves the new number and releases the previous one owned by the same organization', async () => {
    const { db, writes } = createFakeDb({
      organizations: [makeOrg('org_a', '+584111111111')],
      claims: { '+584111111111': 'org_a' },
    });
    jest.spyOn(firebase, 'getFirestore').mockReturnValue(db as any);
    const repo = new OrganizationFirestoreRepository();

    await repo.updateWhatsAppConfiguration(
      'org_a',
      { accountSid: 'AC1', authToken: 'tok', phoneNumber: '+584222222222', enabled: true },
      undefined,
    );

    expect(writes).toContainEqual([
      'set',
      'twilioPhoneNumbers/+584222222222',
      expect.objectContaining({ organizationId: 'org_a' }),
    ]);
    expect(writes).toContainEqual(['delete', 'twilioPhoneNumbers/+584111111111']);
  });

  it('does not reserve or check anything when the number is unchanged', async () => {
    const { db, writes } = createFakeDb({
      organizations: [makeOrg('org_a', '+584111111111')],
    });
    jest.spyOn(firebase, 'getFirestore').mockReturnValue(db as any);
    const repo = new OrganizationFirestoreRepository();

    await repo.updateWhatsAppConfiguration(
      'org_a',
      { accountSid: 'AC1', authToken: 'tok', phoneNumber: '+584111111111', enabled: true },
      undefined,
    );

    expect(writes.some(([, path]) => path.startsWith('twilioPhoneNumbers/'))).toBe(false);
  });

  it('rejects creating an organization with a number reserved elsewhere', async () => {
    const { db, writes } = createFakeDb({
      organizations: [makeOrg('org_a', '+584111111111')],
      claims: { '+584111111111': 'org_a' },
    });
    jest.spyOn(firebase, 'getFirestore').mockReturnValue(db as any);
    const repo = new OrganizationFirestoreRepository();

    await expect(repo.createWithTwilioClaim(makeOrg('org_c', '+584111111111'))).rejects.toMatchObject({
      code: 'TWILIO_NUMBER_IN_USE',
    });
    expect(writes).toEqual([]);
  });

  it('releases the claim only when deleting the organization that owns it', async () => {
    const { db, writes } = createFakeDb({
      organizations: [makeOrg('org_a', '+584111111111')],
      claims: { '+584111111111': 'org_a' },
    });
    jest.spyOn(firebase, 'getFirestore').mockReturnValue(db as any);
    const repo = new OrganizationFirestoreRepository();

    await repo.deleteWithTwilioClaim('org_a', '+584111111111');

    expect(writes).toContainEqual(['delete', 'organizations/org_a']);
    expect(writes).toContainEqual(['delete', 'twilioPhoneNumbers/+584111111111']);
  });

  it('fails the webhook lookup when a number resolves to more than one organization', async () => {
    const { db } = createFakeDb({ organizations: [] });
    jest.spyOn(firebase, 'getFirestore').mockReturnValue(db as any);
    const repo = new OrganizationFirestoreRepository();
    jest
      .spyOn(repo as any, 'listByField')
      .mockResolvedValue([makeOrg('org_a', '+584111111111'), makeOrg('org_b', '+584111111111')]);

    await expect(repo.findByTwilioPhoneNumber('+584111111111')).rejects.toMatchObject({
      code: 'TWILIO_NUMBER_AMBIGUOUS',
    });
  });
});
