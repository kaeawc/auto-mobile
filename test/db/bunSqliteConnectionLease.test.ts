import { describe, expect, it } from "bun:test";
import { BunSqliteConnectionLease } from "../../src/db/BunSqliteConnectionLease";
import { BunSqliteConnectionState } from "../../src/db/BunSqliteConnectionState";

describe("BunSqliteConnectionLease.streamQuery", () => {
  it("fails on first iteration, not when the iterator is created", async () => {
    const state = new BunSqliteConnectionState(() => {
      throw new Error("the database must not be opened to reject streaming");
    });
    const iterator = new BunSqliteConnectionLease(state).streamQuery();

    await expect(iterator.next()).rejects.toThrow("Streaming is not supported");
    expect(iterator[Symbol.asyncIterator]()).toBe(iterator);
  });
});
