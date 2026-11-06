/**
 * Firestore en memoria para probar transacciones. Como el real, exige leer antes de escribir
 * y vuelve a ejecutar la transacción si algo de lo que leyó cambió antes de confirmar.
 * `overlapNextTransactions(n)` hace que n transacciones terminen de leer antes de que
 * ninguna confirme, para reproducir de forma determinista el caso simultáneo.
 */
export const FAKE_DELETE = { __fakeDelete: true };

type Data = Record<string, any>;
type Filter = [string, string, unknown];

const DOCUMENT_ID = '__name__';
const MAX_ATTEMPTS = 10;

function copy<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (Array.isArray(value)) return value.map(copy) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)])) as T;
  }
  return value;
}

export function createFakeFirestore() {
  const collections = new Map<string, Map<string, Data>>();
  const versions = new Map<string, number>();
  let commits = 0;
  let barrier: { remaining: number; release: () => void; reached: Promise<void> } | undefined;

  const waitForOverlap = async (): Promise<void> => {
    const current = barrier;
    if (!current) return;
    current.remaining -= 1;
    if (current.remaining === 0) {
      barrier = undefined;
      current.release();
    }
    await current.reached;
  };

  const documents = (name: string): Map<string, Data> => {
    let collection = collections.get(name);
    if (!collection) {
      collection = new Map();
      collections.set(name, collection);
    }
    return collection;
  };
  const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));
  const pathOf = (ref: FakeRef) => `${ref.collection}/${ref.id}`;

  const write = (ref: FakeRef, data: Data) => {
    documents(ref.collection).set(ref.id, copy(data));
    versions.set(pathOf(ref), (versions.get(pathOf(ref)) ?? 0) + 1);
  };
  const mergeUpdate = (ref: FakeRef, fields: Data) => {
    const current = documents(ref.collection).get(ref.id);
    if (!current) throw new Error(`NOT_FOUND: ${pathOf(ref)}`);
    const next = { ...current };
    Object.entries(fields).forEach(([key, value]) => {
      if (value === FAKE_DELETE) delete next[key];
      else next[key] = value;
    });
    write(ref, next);
  };
  const remove = (ref: FakeRef) => {
    documents(ref.collection).delete(ref.id);
    versions.set(pathOf(ref), (versions.get(pathOf(ref)) ?? 0) + 1);
  };

  const snapshot = (ref: FakeRef) => {
    const data = documents(ref.collection).get(ref.id);
    return {
      id: ref.id,
      ref,
      exists: data !== undefined,
      data: () => (data ? copy(data) : undefined),
      get: (field: string) => data?.[field],
    };
  };

  class FakeRef {
    constructor(public collection: string, public id: string) {}
    async get() {
      return snapshot(this);
    }
    async set(data: Data) {
      write(this, data);
    }
    async update(fields: Data) {
      mergeUpdate(this, fields);
    }
    async delete() {
      remove(this);
    }
  }

  class FakeQuery {
    constructor(public collection: string, public filters: Filter[] = [], private max?: number) {}
    where(field: string, op: string, value: unknown) {
      return new FakeQuery(this.collection, [...this.filters, [field, op, value]], this.max);
    }
    limit(max: number) {
      return new FakeQuery(this.collection, this.filters, max);
    }
    doc(id: string) {
      return new FakeRef(this.collection, id);
    }
    matchingRefs(): FakeRef[] {
      const refs = [...documents(this.collection).entries()]
        .filter(([id, data]) =>
          this.filters.every(([field, op, value]) => {
            const actual = field === DOCUMENT_ID ? id : data[field];
            return op === 'in' ? (value as unknown[]).includes(actual) : actual === value;
          })
        )
        .map(([id]) => new FakeRef(this.collection, id));
      return this.max ? refs.slice(0, this.max) : refs;
    }
    async get() {
      const docs = this.matchingRefs().map(snapshot);
      return { docs, size: docs.length, empty: docs.length === 0 };
    }
  }

  const db = {
    collection: (name: string) => new FakeQuery(name),
    batch: () => {
      const operations: Array<() => void> = [];
      return {
        set: (ref: FakeRef, data: Data) => operations.push(() => write(ref, data)),
        update: (ref: FakeRef, fields: Data) => operations.push(() => mergeUpdate(ref, fields)),
        delete: (ref: FakeRef) => operations.push(() => remove(ref)),
        commit: async () => operations.forEach((operation) => operation()),
      };
    },
    async runTransaction<R>(work: (transaction: any) => Promise<R>): Promise<R> {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const readVersions = new Map<string, number>();
        const queries: Array<{ query: FakeQuery; ids: string }> = [];
        const operations: Array<() => void> = [];
        const remember = (ref: FakeRef) => readVersions.set(pathOf(ref), versions.get(pathOf(ref)) ?? 0);
        const assertNoWritesYet = () => {
          if (operations.length > 0) {
            throw new Error('Firestore transactions require all reads before all writes.');
          }
        };
        const queryIds = (query: FakeQuery) => query.matchingRefs().map((ref) => ref.id).sort().join(',');

        const result = await work({
          get: async (target: FakeRef | FakeQuery) => {
            assertNoWritesYet();
            await yieldTurn();
            if (target instanceof FakeQuery) {
              target.matchingRefs().forEach(remember);
              queries.push({ query: target, ids: queryIds(target) });
              return target.get();
            }
            remember(target);
            return snapshot(target);
          },
          getAll: async (...refs: FakeRef[]) => {
            assertNoWritesYet();
            await yieldTurn();
            refs.forEach(remember);
            return refs.map(snapshot);
          },
          set: (ref: FakeRef, data: Data) => operations.push(() => write(ref, data)),
          create: (ref: FakeRef, data: Data) =>
            operations.push(() => {
              if (documents(ref.collection).has(ref.id)) throw new Error(`ALREADY_EXISTS: ${pathOf(ref)}`);
              write(ref, data);
            }),
          update: (ref: FakeRef, fields: Data) => operations.push(() => mergeUpdate(ref, fields)),
          delete: (ref: FakeRef) => operations.push(() => remove(ref)),
        });

        await waitForOverlap();

        const conflict =
          [...readVersions].some(([path, version]) => (versions.get(path) ?? 0) !== version) ||
          queries.some(({ query, ids }) => queryIds(query) !== ids);
        if (!conflict) {
          operations.forEach((operation) => operation());
          commits++;
          return result;
        }
      }
      throw new Error('Transaction contention: too many attempts.');
    },
  };

  return {
    db,
    admin: {
      firestore: {
        FieldValue: { delete: () => FAKE_DELETE },
        FieldPath: { documentId: () => DOCUMENT_ID },
      },
    },
    seed(collection: string, document: { id: string } & Data) {
      write(new FakeRef(collection, document.id), document);
    },
    read(collection: string, id: string): Data | undefined {
      return copy(documents(collection).get(id));
    },
    all(collection: string): Data[] {
      return [...documents(collection).values()].map(copy);
    },
    overlapNextTransactions(count: number) {
      let release: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => {
        release = resolve;
      });
      barrier = { remaining: count, release, reached };
    },
    clear() {
      barrier = undefined;
      collections.clear();
      versions.clear();
      commits = 0;
    },
    get commits() {
      return commits;
    },
  };
}
