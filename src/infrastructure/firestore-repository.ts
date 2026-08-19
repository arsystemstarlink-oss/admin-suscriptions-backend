import { getFirestore } from './firebase';
import { Identifiable } from '../domain/in-memory-repository';

export interface ListPageParams {
  organizationId?: string;
  orderBy?: string;
  direction?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface ListPageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export class FirestoreRepository<T extends Identifiable> {
  protected collectionName: string;

  constructor(collectionName: string) {
    this.collectionName = collectionName;
  }

  protected get db() {
    return getFirestore();
  }

  protected serialize(entity: T): any {
    const serialized: any = { ...entity };
    
    Object.keys(serialized).forEach((key) => {
      const value = serialized[key];
      if (value === undefined) {
        delete serialized[key];
      } else if (value instanceof Date) {
        serialized[key] = value;
      }
    });

    return serialized;
  }

  protected deserialize(data: any): T {
    const deserialized: any = { ...data };

    Object.keys(deserialized).forEach((key) => {
      const value = deserialized[key];
      if (value && typeof value === 'object' && value._seconds !== undefined) {
        deserialized[key] = value.toDate();
      }
    });

    return deserialized as T;
  }

  async create(entity: T): Promise<void> {
    const docRef = this.db.collection(this.collectionName).doc(entity.id);
    const existing = await docRef.get();

    if (existing.exists) {
      throw new Error(`Entity with id ${entity.id} already exists.`);
    }

    await docRef.set(this.serialize(entity));
  }

  async update(entity: T): Promise<void> {
    const docRef = this.db.collection(this.collectionName).doc(entity.id);
    const existing = await docRef.get();

    if (!existing.exists) {
      throw new Error(`Entity with id ${entity.id} does not exist.`);
    }

    await docRef.update(this.serialize(entity));
  }

  async getById(id: string): Promise<T | undefined> {
    const docRef = this.db.collection(this.collectionName).doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return undefined;
    }

    return this.deserialize({ id: doc.id, ...doc.data() });
  }

  async list(): Promise<T[]> {
    const snapshot = await this.db.collection(this.collectionName).get();
    return snapshot.docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));
  }

  async listByOrganization(organizationId?: string): Promise<T[]> {
    if (!organizationId) {
      return this.list();
    }
    return this.listByField('organizationId', organizationId);
  }

  async listPage(params: ListPageParams): Promise<ListPageResult<T>> {
    let query: FirebaseFirestore.Query = this.db.collection(this.collectionName);
    let countQuery: FirebaseFirestore.Query = this.db.collection(this.collectionName);

    if (params.organizationId) {
      query = query.where('organizationId', '==', params.organizationId);
      countQuery = countQuery.where('organizationId', '==', params.organizationId);
    }

    const orderByField = params.orderBy || 'createdAt';
    const direction: FirebaseFirestore.OrderByDirection = params.direction === 'asc' ? 'asc' : 'desc';
    query = query.orderBy(orderByField, direction).offset(params.offset).limit(params.limit);

    const [snapshot, countSnapshot] = await Promise.all([
      query.get(),
      countQuery.count().get(),
    ]);

    const items = snapshot.docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));
    const total = countSnapshot.data().count;

    return {
      items,
      total,
      limit: params.limit,
      offset: params.offset,
      hasMore: params.offset + items.length < total,
    };
  }

  async getByIdScoped(id: string, organizationId?: string): Promise<T | undefined> {
    const entity = await this.getById(id);
    if (!entity) {
      return undefined;
    }
    if (organizationId && (entity as any).organizationId !== organizationId) {
      return undefined;
    }
    return entity;
  }

  async delete(id: string): Promise<void> {
    await this.db.collection(this.collectionName).doc(id).delete();
  }

  async listByField(field: string, value: any): Promise<T[]> {
    const snapshot = await this.db
      .collection(this.collectionName)
      .where(field, '==', value)
      .get();

    return snapshot.docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));
  }

  async listByFields(fields: Array<[string, any]>): Promise<T[]> {
    let query: FirebaseFirestore.Query = this.db.collection(this.collectionName);
    fields.forEach(([field, value]) => {
      query = query.where(field, '==', value);
    });

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));
  }

  async deleteByField(field: string, value: any): Promise<number> {
    const snapshot = await this.db
      .collection(this.collectionName)
      .where(field, '==', value)
      .get();

    await this.deleteSnapshotInChunks(snapshot);
    return snapshot.size;
  }

  async deleteByFields(fields: Array<[string, any]>): Promise<number> {
    let query: FirebaseFirestore.Query = this.db.collection(this.collectionName);
    fields.forEach(([field, value]) => {
      query = query.where(field, '==', value);
    });

    const snapshot = await query.get();

    await this.deleteSnapshotInChunks(snapshot);
    return snapshot.size;
  }

  private async deleteSnapshotInChunks(snapshot: FirebaseFirestore.QuerySnapshot): Promise<void> {
    const MAX_BATCH_WRITES = 400;
    const docs = snapshot.docs;

    for (let i = 0; i < docs.length; i += MAX_BATCH_WRITES) {
      const chunk = docs.slice(i, i + MAX_BATCH_WRITES);
      const batch = this.db.batch();
      chunk.forEach((doc) => {
        batch.delete(doc.ref);
      });
      await batch.commit();
    }
  }
}
