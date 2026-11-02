/**
 * Runs async tasks one at a time per key, in submission order. Tasks for
 * different keys run concurrently.
 */
export class SerialQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(task, task);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  busy(key: string): boolean {
    return this.tails.has(key);
  }

  /** Resolves once every task queued so far (for any key) has settled. */
  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.allSettled([...this.tails.values()]);
  }
}
