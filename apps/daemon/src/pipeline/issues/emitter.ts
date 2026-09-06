/**
 * Minimal typed event emitter.
 *
 * The pipeline exposes its kanban update events through one of these so the
 * API layer (#9) can subscribe without depending on Node's stringly-typed
 * `EventEmitter`. Listener errors are swallowed: a broken subscriber must
 * never break the spawn pipeline.
 */

export type EventListener<T> = (event: T) => void;

export class Emitter<T> {
  private readonly listeners = new Set<EventListener<T>>();

  /** Subscribes a listener; returns an unsubscribe function. */
  on(listener: EventListener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Notifies every current listener (snapshot; unsubscribes mid-emit are honored). */
  emit(event: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A failing subscriber must not break the pipeline.
      }
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
