// Tiny strongly typed event emitter.

type Handler<T> = (payload: T) => void;

export class EventBus<M extends object> {
  private handlers = new Map<keyof M, Set<Handler<never>>>();

  on<K extends keyof M>(event: K, fn: Handler<M[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn as Handler<never>);
    return () => this.off(event, fn);
  }

  off<K extends keyof M>(event: K, fn: Handler<M[K]>) {
    this.handlers.get(event)?.delete(fn as Handler<never>);
  }

  emit<K extends keyof M>(event: K, payload: M[K]) {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Handler<M[K]>)(payload);
      } catch (err) {
        console.error(`[event ${String(event)}]`, err);
      }
    }
  }

  clear() {
    this.handlers.clear();
  }
}
