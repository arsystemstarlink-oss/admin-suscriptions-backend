import { getFirestore } from './firebase';
import { Identifiable } from '../domain/in-memory-repository';
import { getRequestContext } from '../api/middleware/request-id';

export interface ListPageParams {
  organizationId?: string;
  orderBy?: string;
  direction?: 'asc' | 'desc';
  limit: number;
  offset: number;
  requireTotal?: boolean;
}

export interface ListPageResult<T> {
  items: T[];
  total?: number;
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

  private logOperation(operation: string, documentId?: string): void {
    const ctx = getRequestContext();
    if (!ctx) return;
    console.log(`[${ctx.requestId}] ${operation} ${this.collectionName}${documentId ? `/${documentId}` : ''}`);
  }

  protected serialize(entity: T): any {
    const stripUndefined = (value: any): any => {
      if (value instanceof Date) {
        return value;
      }
      if (Array.isArray(value)) {
        return value.map(stripUndefined);
      }
      if (value && typeof value === 'object') {
        const cleaned: any = {};
        Object.keys(value).forEach((key) => {
          if (value[key] !== undefined) {
            cleaned[key] = stripUndefined(value[key]);
          }
        });
        return cleaned;
      }
      return value;
    };

    return stripUndefined(entity);
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
    this.logOperation('WRITE', entity.id);
    const docRef = this.db.collection(this.collectionName).doc(entity.id);
    await docRef.set(this.serialize(entity));
  }

  async update(entity: T): Promise<void> {
    this.logOperation('WRITE', entity.id);
    const docRef = this.db.collection(this.collectionName).doc(entity.id);
    await docRef.update(this.serialize(entity));
  }

  async getById(id: string): Promise<T | undefined> {
    this.logOperation('READ', id);
    const docRef = this.db.collection(this.collectionName).doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return undefined;
    }

    return this.deserialize({ id: doc.id, ...doc.data() });
  }

  async list(): Promise<T[]> {
    this.logOperation('LIST');
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
    this.logOperation('QUERY');
    let query: FirebaseFirestore.Query = this.db.collection(this.collectionName);

    if (params.organizationId) {
      query = query.where('organizationId', '==', params.organizationId);
    }

    const orderByField = params.orderBy || 'createdAt';
    const direction: FirebaseFirestore.OrderByDirection = params.direction === 'asc' ? 'asc' : 'desc';
    query = query.orderBy(orderByField, direction).offset(params.offset).limit(params.limit);

    const snapshot = await query.get();
    const items = snapshot.docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));

    let total: number | undefined;
    let hasMore = false;

    if (params.requireTotal) {
      this.logOperation('COUNT');
      const countSnapshot = await this.db.collection(this.collectionName).count().get();
      total = countSnapshot.data().count;
      hasMore = params.offset + items.length < total;
    } else {
      hasMore = items.length >= params.limit;
    }

    return {
      items,
      total,
      limit: params.limit,
      offset: params.offset,
      hasMore,
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
    this.logOperation('DELETE', id);
    await this.db.collection(this.collectionName).doc(id).delete();
  }

  async listByField(field: string, value: any, limit?: number): Promise<T[]> {
    this.logOperation('QUERY');
    if (value === undefined) {
      return this.list();
    }
    let query: FirebaseFirestore.Query = this.db.collection(this.collectionName).where(field, '==', value);
    if (limit) {
      query = query.limit(limit);
    }
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));
  }

  async listByFields(fields: Array<[string, any]>, limit?: number): Promise<T[]> {
    this.logOperation('QUERY');
    const validFields = fields.filter(([, value]) => value !== undefined);
    if (validFields.length === 0) {
      return this.list();
    }
    let query: FirebaseFirestore.Query = this.db.collection(this.collectionName);
    validFields.forEach(([field, value]) => {
      query = query.where(field, '==', value);
    });

    if (limit) {
      query = query.limit(limit);
    }

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));
  }

  async deleteByField(field: string, value: any): Promise<number> {
    if (value === undefined) {
      return 0;
    }
    const snapshot = await this.db
      .collection(this.collectionName)
      .where(field, '==', value)
      .get();

    await this.deleteSnapshotInChunks(snapshot);
    return snapshot.size;
  }

  async deleteByFields(fields: Array<[string, any]>): Promise<number> {
    const validFields = fields.filter(([, value]) => value !== undefined);
    if (validFields.length === 0) {
      return 0;
    }
    let query: FirebaseFirestore.Query = this.db.collection(this.collectionName);
    validFields.forEach(([field, value]) => {
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
