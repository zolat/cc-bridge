import type { PendingRequestEntry } from "./types.js";

export class PendingRequestMap {
  private requests = new Map<string, PendingRequestEntry>();
  private counter = 0;

  generateId(): string {
    return `br-${Date.now()}-${++this.counter}`;
  }

  add(
    id: string,
    model: string,
    timeoutMs: number
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error("Request timed out"));
      }, timeoutMs);

      this.requests.set(id, {
        resolve,
        reject,
        timer,
        model,
        createdAt: Date.now(),
      });
    });
  }

  resolve(id: string, content: string): boolean {
    const pending = this.requests.get(id);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.requests.delete(id);
    pending.resolve(content);
    return true;
  }

  cancel(id: string): void {
    const pending = this.requests.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.requests.delete(id);
    }
  }

  get size(): number {
    return this.requests.size;
  }
}
