import { describe, expect, test } from "bun:test";
import path from "node:path";
import { ToolOutputArtifactLedger } from "../../src/server/toolOutputArtifactLedger";

describe("ToolOutputArtifactLedger (#5917)", () => {
  test("resolves only paths that were recorded, by basename", () => {
    const ledger = new ToolOutputArtifactLedger();
    const issued = path.resolve("/tmp/tool-outputs/1234-observe-abc.json");
    ledger.record(issued);

    expect(ledger.resolve("1234-observe-abc.json")).toBe(issued);
    // A never-issued, writer-shaped sibling is not resolvable.
    expect(ledger.resolve("1234-observe-def.json")).toBeUndefined();
    expect(ledger.resolve("credentials.json")).toBeUndefined();
  });

  test("forget removes an issued entry", () => {
    const ledger = new ToolOutputArtifactLedger();
    const issued = path.resolve("/tmp/tool-outputs/1-observe-x.json");
    ledger.record(issued);
    expect(ledger.resolve("1-observe-x.json")).toBe(issued);

    ledger.forget(issued);
    expect(ledger.resolve("1-observe-x.json")).toBeUndefined();
  });

  test("is bounded and evicts the oldest issued entries first", () => {
    const ledger = new ToolOutputArtifactLedger(2);
    const a = path.resolve("/tmp/tool-outputs/1-observe-a.json");
    const b = path.resolve("/tmp/tool-outputs/2-observe-b.json");
    const c = path.resolve("/tmp/tool-outputs/3-observe-c.json");

    ledger.record(a);
    ledger.record(b);
    ledger.record(c);

    expect(ledger.size).toBe(2);
    // Oldest (a) evicted; newest two retained.
    expect(ledger.resolve("1-observe-a.json")).toBeUndefined();
    expect(ledger.resolve("2-observe-b.json")).toBe(b);
    expect(ledger.resolve("3-observe-c.json")).toBe(c);
  });

  test("re-recording refreshes recency so it survives eviction", () => {
    const ledger = new ToolOutputArtifactLedger(2);
    const a = path.resolve("/tmp/tool-outputs/1-observe-a.json");
    const b = path.resolve("/tmp/tool-outputs/2-observe-b.json");
    const c = path.resolve("/tmp/tool-outputs/3-observe-c.json");

    ledger.record(a);
    ledger.record(b);
    ledger.record(a); // refresh a's recency
    ledger.record(c); // should evict b, not a

    expect(ledger.resolve("1-observe-a.json")).toBe(a);
    expect(ledger.resolve("2-observe-b.json")).toBeUndefined();
    expect(ledger.resolve("3-observe-c.json")).toBe(c);
  });

  test("clear drops every entry", () => {
    const ledger = new ToolOutputArtifactLedger();
    ledger.record(path.resolve("/tmp/tool-outputs/1-observe-a.json"));
    ledger.clear();
    expect(ledger.size).toBe(0);
    expect(ledger.resolve("1-observe-a.json")).toBeUndefined();
  });
});
