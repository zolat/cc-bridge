import { describe, it, expect } from "bun:test";
import { PendingRequestMap } from "../src/pending.js";

describe("PendingRequestMap", () => {
  it("generates unique IDs", () => {
    const pending = new PendingRequestMap();
    const id1 = pending.generateId();
    const id2 = pending.generateId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^br-\d+-\d+$/);
  });

  it("resolves a pending request", async () => {
    const pending = new PendingRequestMap();
    const id = pending.generateId();
    const promise = pending.add(id, "sonnet", 5000);
    expect(pending.size).toBe(1);

    pending.resolve(id, "Hello!");
    const result = await promise;
    expect(result).toBe("Hello!");
    expect(pending.size).toBe(0);
  });

  it("returns false when resolving unknown ID", () => {
    const pending = new PendingRequestMap();
    expect(pending.resolve("nonexistent", "content")).toBe(false);
  });

  it("times out after specified duration", async () => {
    const pending = new PendingRequestMap();
    const id = pending.generateId();
    const promise = pending.add(id, "sonnet", 50);

    try {
      await promise;
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect((err as Error).message).toBe("Request timed out");
    }
    expect(pending.size).toBe(0);
  });

  it("cancels a pending request", async () => {
    const pending = new PendingRequestMap();
    const id = pending.generateId();
    pending.add(id, "sonnet", 5000);
    expect(pending.size).toBe(1);

    pending.cancel(id);
    expect(pending.size).toBe(0);
  });

  it("cancel is safe on unknown ID", () => {
    const pending = new PendingRequestMap();
    expect(() => pending.cancel("nonexistent")).not.toThrow();
  });

  it("tracks size correctly across operations", async () => {
    const pending = new PendingRequestMap();
    expect(pending.size).toBe(0);

    const id1 = pending.generateId();
    const id2 = pending.generateId();
    const p1 = pending.add(id1, "sonnet", 5000);
    pending.add(id2, "haiku", 5000);
    expect(pending.size).toBe(2);

    pending.resolve(id1, "done");
    await p1;
    expect(pending.size).toBe(1);

    pending.cancel(id2);
    expect(pending.size).toBe(0);
  });
});
