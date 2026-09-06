import { describe, expect, test } from "bun:test";
import {
  InMemoryToolSelectionProfileRegistry,
  PersistentToolSelectionProfileRegistry,
} from "../../src/server/toolSelectionProfileRegistry";
import type { ToolSelectionProfileProvenanceRepository } from "../../src/db/toolSelectionProfileProvenanceRepository";

/**
 * A synchronous in-memory stand-in for `ToolSelectionProfileProvenanceRepository`
 * (issue #6225). `insert`/`loadAll` mutate `stored` before their `async` body
 * hits its first (nonexistent) `await`, so the mutation is visible synchronously
 * even though the method returns a `Promise` — matching how the real repository's
 * write-through is exercised via the fire-and-forget `record()` path. Keeps this
 * suite <100ms with no DB (per CLAUDE.md).
 */
class FakeToolSelectionProfileProvenanceRepository {
  readonly stored = new Set<string>();
  insertCalls: string[] = [];

  async insert(profileUuid: string): Promise<void> {
    this.insertCalls.push(profileUuid);
    this.stored.add(profileUuid);
  }

  async loadAll(): Promise<string[]> {
    return [...this.stored];
  }
}

function asRepository(
  fake: FakeToolSelectionProfileProvenanceRepository,
): ToolSelectionProfileProvenanceRepository {
  return fake as unknown as ToolSelectionProfileProvenanceRepository;
}

/**
 * #6148 round 4 — the registry is the provenance signal that must survive the
 * daemon-proxy loopback hop: a value is recognized purely by having been
 * `record`ed, independent of any particular mcpSessionId/createMcpServer
 * instance.
 */
describe("InMemoryToolSelectionProfileRegistry (#6148)", () => {
  test("recognizes a recorded uuid", () => {
    const registry = new InMemoryToolSelectionProfileRegistry();
    registry.record("minted-uuid");

    expect(registry.has("minted-uuid")).toBe(true);
  });

  test("rejects a value that was never recorded", () => {
    const registry = new InMemoryToolSelectionProfileRegistry();
    registry.record("minted-uuid");

    expect(registry.has("fabricated-uuid")).toBe(false);
  });

  test("membership does not depend on any particular instance/session key (models surviving the proxy hop)", () => {
    // Two different createMcpServer() instances (as if handling two different
    // internal loopback sessions after a daemon-proxy hop) sharing ONE
    // registry, exactly like production sharing the module default.
    const registry = new InMemoryToolSelectionProfileRegistry();
    // "Instance A" mints and records.
    registry.record("shared-minted-uuid");
    // "Instance B" (a different createMcpServer()/SessionToolBinding, no
    // shared in-memory map with A) still recognizes it via the registry.
    expect(registry.has("shared-minted-uuid")).toBe(true);
  });

  test("ignores an empty or blank uuid", () => {
    const registry = new InMemoryToolSelectionProfileRegistry();
    registry.record("");
    registry.record("   ");

    expect(registry.has("")).toBe(false);
    expect(registry.has("   ")).toBe(false);
  });
});

/**
 * Issue #6225 (#6148/#6213 follow-up): durability across a simulated daemon
 * restart, while keeping the #6148 fabricated-value rejection intact.
 */
describe("PersistentToolSelectionProfileRegistry (#6225)", () => {
  test("recognizes a recorded uuid immediately (in-memory fast path unchanged)", () => {
    const registry = new PersistentToolSelectionProfileRegistry(
      asRepository(new FakeToolSelectionProfileProvenanceRepository()),
    );
    registry.record("minted-uuid");

    expect(registry.has("minted-uuid")).toBe(true);
  });

  test("rejects a value that was never recorded", () => {
    const registry = new PersistentToolSelectionProfileRegistry(
      asRepository(new FakeToolSelectionProfileProvenanceRepository()),
    );
    registry.record("minted-uuid");

    expect(registry.has("fabricated-uuid")).toBe(false);
  });

  test("ignores an empty or blank uuid, and never writes it through", () => {
    const repo = new FakeToolSelectionProfileProvenanceRepository();
    const registry = new PersistentToolSelectionProfileRegistry(asRepository(repo));
    registry.record("");
    registry.record("   ");

    expect(registry.has("")).toBe(false);
    expect(registry.has("   ")).toBe(false);
    expect(repo.insertCalls).toEqual([]);
  });

  test("record() write-throughs the minted uuid to the durable store", () => {
    const repo = new FakeToolSelectionProfileProvenanceRepository();
    const registry = new PersistentToolSelectionProfileRegistry(asRepository(repo));
    registry.record("minted-uuid");

    expect(repo.insertCalls).toEqual(["minted-uuid"]);
    expect(repo.stored.has("minted-uuid")).toBe(true);
  });

  test("a fabricated value is never persisted (has() stays false even after a would-be reload)", async () => {
    const repo = new FakeToolSelectionProfileProvenanceRepository();
    const registry = new PersistentToolSelectionProfileRegistry(asRepository(repo));
    registry.record("minted-uuid");

    // Never call record("fabricated-uuid") — a caller merely CLAIMING that
    // value never puts it in the store.
    expect(repo.stored.has("fabricated-uuid")).toBe(false);

    await registry.load();
    expect(registry.has("fabricated-uuid")).toBe(false);
  });

  test("simulated daemon restart: a fresh registry sharing the durable store recognizes a previously minted profile after load()", async () => {
    // "Before restart": one daemon process mints a profile against the durable store.
    const sharedRepo = new FakeToolSelectionProfileProvenanceRepository();
    const before = new PersistentToolSelectionProfileRegistry(asRepository(sharedRepo));
    before.record("minted-uuid");
    expect(before.has("minted-uuid")).toBe(true);

    // "After restart": a BRAND NEW registry (in-memory set is empty, as it would
    // be for a freshly-constructed process-wide singleton) backed by the SAME
    // durable store the old process wrote to.
    const after = new PersistentToolSelectionProfileRegistry(asRepository(sharedRepo));
    expect(after.has("minted-uuid")).toBe(false); // not yet loaded

    await after.load();

    // Reaffirmation succeeds without re-minting.
    expect(after.has("minted-uuid")).toBe(true);
  });

  test("simulated daemon restart: a fabricated/never-minted value is still rejected after load()", async () => {
    const sharedRepo = new FakeToolSelectionProfileProvenanceRepository();
    const before = new PersistentToolSelectionProfileRegistry(asRepository(sharedRepo));
    before.record("minted-uuid");

    const after = new PersistentToolSelectionProfileRegistry(asRepository(sharedRepo));
    await after.load();

    expect(after.has("minted-uuid")).toBe(true);
    expect(after.has("fabricated-uuid")).toBe(false);
  });

  test("load() merges persisted entries without clearing anything already recorded in this process", async () => {
    const sharedRepo = new FakeToolSelectionProfileProvenanceRepository();
    sharedRepo.stored.add("persisted-uuid");
    const registry = new PersistentToolSelectionProfileRegistry(asRepository(sharedRepo));
    registry.record("locally-minted-uuid");

    await registry.load();

    expect(registry.has("locally-minted-uuid")).toBe(true);
    expect(registry.has("persisted-uuid")).toBe(true);
  });
});
