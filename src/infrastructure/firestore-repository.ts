import { getFirestore } from './firebase';
import { Identifiable } from '../domain/in-memory-repository';

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

  async deleteByField(field: string, value: any): Promise<number> {
    const snapshot = await this.db
      .collection(this.collectionName)
      .where(field, '==', value)
      .get();

    const batch = this.db.batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    await batch.commit();
    return snapshot.size;
  }
}
