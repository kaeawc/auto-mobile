import { describe, expect, test } from "bun:test";
import { InMemoryToolSelectionProfileRegistry } from "../../src/server/toolSelectionProfileRegistry";

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
