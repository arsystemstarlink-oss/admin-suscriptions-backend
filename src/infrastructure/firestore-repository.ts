import { getFirestore, admin } from './firebase';
import { Identifiable } from '../domain/in-memory-repository';
import { BusinessError } from '../domain/entities';
import {
  getRequestContext,
  recordAggregation,
  recordDocReads,
  recordQuery,
  recordWrite,
} from '../api/middleware/request-id';

export type QueryFilter = [
  field: string | FirebaseFirestore.FieldPath,
  op: FirebaseFirestore.WhereFilterOp,
  value: any,
];

export interface ListQueryOptions {
  orderBy?: string;
  direction?: 'asc' | 'desc';
  limit?: number;
}

export interface ListPageParams {
  organizationId?: string;
  filters?: QueryFilter[];
  orderBy?: string;
  direction?: 'asc' | 'desc';
  limit: number;
  /** @deprecated usar cursor. Firestore factura los documentos saltados. */
  offset?: number;
  cursor?: string;
  requireTotal?: boolean;
}

export interface ListPageResult<T> {
  items: T[];
  total?: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextCursor?: string;
}

export function encodeCursor(values: any[], id: string): string {
  const normalize = (value: any): any => {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value && typeof value.toDate === 'function') {
      return value.toDate().toISOString();
    }
    return value;
  };
  const normalized = values.map(normalize);
  return Buffer.from(JSON.stringify({ v: normalized, id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { values: any[]; id: string } | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.id !== 'string' || !Array.isArray(parsed.v)) {
      return undefined;
    }
    const values = parsed.v.map((value: any) => {
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
        return new Date(value);
      }
      return value;
    });
    return { values, id: parsed.id };
  } catch {
    return undefined;
  }
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
      if (value instanceof Date) {
        return;
      }
      if (value && typeof value === 'object') {
        if (typeof value.toDate === 'function') {
          try {
            deserialized[key] = value.toDate();
          } catch {
            // conservar valor original si la conversión falla
          }
          return;
        }
        if (typeof value._seconds === 'number') {
          deserialized[key] = new Date(value._seconds * 1000);
          return;
        }
        if (typeof value.seconds === 'number') {
          const nanos = typeof value.nanoseconds === 'number' ? value.nanoseconds : 0;
          deserialized[key] = new Date(value.seconds * 1000 + Math.round(nanos / 1e6));
        }
      }
    });

    return deserialized as T;
  }

  async create(entity: T): Promise<void> {
    this.logOperation('WRITE', entity.id);
    recordWrite();
    const docRef = this.db.collection(this.collectionName).doc(entity.id);
    await docRef.set(this.serialize(entity));
  }

  async update(entity: T): Promise<void> {
    this.logOperation('WRITE', entity.id);
    recordWrite();
    const docRef = this.db.collection(this.collectionName).doc(entity.id);
    await docRef.update(this.serialize(entity));
  }

  async getById(id: string): Promise<T | undefined> {
    this.logOperation('READ', id);
    recordDocReads();
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
    recordQuery();
    recordDocReads(snapshot.size);
    return snapshot.docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));
  }

  async listByOrganization(organizationId: string): Promise<T[]> {
    if (!organizationId) {
      throw new BusinessError(
        'INVALID_QUERY',
        `listByOrganization requiere organizationId (${this.collectionName}).`
      );
    }
    return this.listByField('organizationId', organizationId);
  }

  async listPage(params: ListPageParams): Promise<ListPageResult<T>> {
    this.logOperation('QUERY');
    let query: FirebaseFirestore.Query = this.db.collection(this.collectionName);

    if (params.organizationId) {
      query = query.where('organizationId', '==', params.organizationId);
    }

    for (const [field, op, value] of params.filters ?? []) {
      if (value === undefined) continue;
      query = query.where(field as any, op, value);
    }

    const orderByField = params.orderBy || 'createdAt';
    const direction: FirebaseFirestore.OrderByDirection = params.direction === 'asc' ? 'asc' : 'desc';
    query = query
      .orderBy(orderByField, direction)
      .orderBy(admin.firestore.FieldPath.documentId(), direction);

    const decoded = params.cursor ? decodeCursor(params.cursor) : undefined;
    if (decoded && decoded.values.length > 0) {
      query = query.startAfter(...decoded.values, decoded.id);
    } else if (params.offset) {
      query = query.offset(params.offset);
    }

    const fetchLimit = params.limit + 1;
    const snapshot = await query.limit(fetchLimit).get();
    recordQuery();
    recordDocReads(snapshot.size);

    const hasExtra = snapshot.docs.length > params.limit;
    const docs = hasExtra ? snapshot.docs.slice(0, params.limit) : snapshot.docs;
    const items = docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));

    let total: number | undefined;
    if (params.requireTotal) {
      this.logOperation('COUNT');
      const countSnapshot = await this.buildQuery([
        ...(params.organizationId ? [['organizationId', '==', params.organizationId] as QueryFilter] : []),
        ...(params.filters ?? []),
      ])
        .count()
        .get();
      recordAggregation();
      total = countSnapshot.data().count;
    }

    const lastDoc = docs[docs.length - 1];
    const nextCursor =
      hasExtra && lastDoc ? encodeCursor([lastDoc.get(orderByField)], lastDoc.id) : undefined;

    const hasMore =
      total !== undefined && !decoded
        ? (params.offset ?? 0) + items.length < total
        : hasExtra;

    return {
      items,
      total,
      limit: params.limit,
      offset: params.offset ?? 0,
      hasMore,
      nextCursor,
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
    recordWrite();
    await this.db.collection(this.collectionName).doc(id).delete();
  }

  async listByField(field: string, value: any, limit?: number): Promise<T[]> {
    this.logOperation('QUERY');
    if (value === undefined) {
      throw new BusinessError(
        'INVALID_QUERY',
        `listByField requiere un valor definido para "${field}" (${this.collectionName}).`
      );
    }
    let query: FirebaseFirestore.Query = this.db.collection(this.collectionName).where(field, '==', value);
    if (limit) {
      query = query.limit(limit);
    }
    const snapshot = await query.get();
    recordQuery();
    recordDocReads(snapshot.size);
    return snapshot.docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));
  }

  async listByFields(fields: Array<[string, any]>, limit?: number): Promise<T[]> {
    this.logOperation('QUERY');
    const validFields = fields.filter(([, value]) => value !== undefined);
    if (validFields.length === 0) {
      throw new BusinessError(
        'INVALID_QUERY',
        `listByFields requiere al menos un filtro definido (${this.collectionName}).`
      );
    }
    let query: FirebaseFirestore.Query = this.db.collection(this.collectionName);
    validFields.forEach(([field, value]) => {
      query = query.where(field, '==', value);
    });

    if (limit) {
      query = query.limit(limit);
    }

    const snapshot = await query.get();
    recordQuery();
    recordDocReads(snapshot.size);
    return snapshot.docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));
  }

  protected buildQuery(filters: QueryFilter[]): FirebaseFirestore.Query {
    let query: FirebaseFirestore.Query = this.db.collection(this.collectionName);
    for (const [field, op, value] of filters) {
      if (value === undefined) continue;
      query = query.where(field as any, op, value);
    }
    return query;
  }

  async countWhere(filters: QueryFilter[]): Promise<number> {
    this.logOperation('COUNT');
    const snapshot = await this.buildQuery(filters).count().get();
    recordAggregation();
    return snapshot.data().count;
  }

  async sumWhere(field: string, filters: QueryFilter[]): Promise<number> {
    this.logOperation('SUM');
    const snapshot = await this.buildQuery(filters)
      .aggregate({ total: admin.firestore.AggregateField.sum(field) })
      .get();
    recordAggregation();
    const total = snapshot.data().total;
    return typeof total === 'number' ? total : 0;
  }

  async listWhere(filters: QueryFilter[], options: ListQueryOptions = {}): Promise<T[]> {
    this.logOperation('QUERY');
    if (!options.limit) {
      throw new BusinessError(
        'INVALID_QUERY',
        `listWhere requiere un límite explícito (${this.collectionName}).`
      );
    }
    let query = this.buildQuery(filters);
    if (options.orderBy) {
      query = query.orderBy(options.orderBy, options.direction === 'asc' ? 'asc' : 'desc');
    }
    query = query.limit(options.limit);
    const snapshot = await query.get();
    recordQuery();
    recordDocReads(snapshot.size);
    return snapshot.docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));
  }

  async listByIds(ids: string[], organizationId?: string): Promise<T[]> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) {
      return [];
    }

    this.logOperation('QUERY');
    const MAX_IN_FILTER = 30;
    const results: T[] = [];

    for (let i = 0; i < unique.length; i += MAX_IN_FILTER) {
      const chunk = unique.slice(i, i + MAX_IN_FILTER);
      const snapshot = await this.db
        .collection(this.collectionName)
        .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
        .get();
      recordQuery();
      recordDocReads(snapshot.size);
      snapshot.docs.forEach((doc) =>
        results.push(this.deserialize({ id: doc.id, ...doc.data() }))
      );
    }

    if (organizationId) {
      return results.filter((item) => (item as any).organizationId === organizationId);
    }
    return results;
  }

  async deleteByField(field: string, value: any): Promise<number> {
    if (value === undefined) {
      return 0;
    }
    const snapshot = await this.db
      .collection(this.collectionName)
      .where(field, '==', value)
      .get();
    recordQuery();
    recordDocReads(snapshot.size);

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
    recordQuery();
    recordDocReads(snapshot.size);

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
      recordWrite(chunk.length);
    }
  }
}
