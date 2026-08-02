export interface Identifiable {
  id: string;
}

export class InMemoryRepository<T extends Identifiable> {
  private store = new Map<string, T>();

  create(entity: T): void {
    if (this.store.has(entity.id)) {
      throw new Error(`Entity with id ${entity.id} already exists.`);
    }
    this.store.set(entity.id, entity);
  }

  update(entity: T): void {
    if (!this.store.has(entity.id)) {
      throw new Error(`Entity with id ${entity.id} does not exist.`);
    }
    this.store.set(entity.id, entity);
  }

  getById(id: string): T | undefined {
    return this.store.get(id);
  }

  list(): T[] {
    return Array.from(this.store.values());
  }

  delete(id: string): void {
    this.store.delete(id);
  }
}
