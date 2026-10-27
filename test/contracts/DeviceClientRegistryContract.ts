import { describe, expect, test } from "bun:test";
import type { DeviceClientRegistry } from "../../src/ctrlProxy/deviceClientRegistry";

/** A registry under test plus a way to mint distinct values and restore pristine state. */
export interface DeviceClientRegistryHarness {
  registry: DeviceClientRegistry<object>;
  /** Drop instances and retired marks so the shared (static) registries start clean. */
  reset(): void;
}

/** The same lifecycle assertions for every `DeviceClientRegistry` implementation. */
export function runDeviceClientRegistryContract(
  name: string,
  makeHarness: () => DeviceClientRegistryHarness,
): void {
  describe(`DeviceClientRegistry contract: ${name}`, () => {
    const withHarness = (body: (registry: DeviceClientRegistry<object>) => void) => () => {
      const harness = makeHarness();
      harness.reset();
      try {
        body(harness.registry);
      } finally {
        harness.reset();
      }
    };

    test(
      "get creates once and returns the same instance",
      withHarness((registry) => {
        let creations = 0;
        const make = () => {
          creations += 1;
          return {};
        };
        const first = registry.get("dev-1", make);
        expect(registry.get("dev-1", make)).toBe(first);
        expect(creations).toBe(1);
        expect(registry.peek("dev-1")).toBe(first);
      }),
    );

    test(
      "peek never creates",
      withHarness((registry) => {
        expect(registry.peek("dev-1")).toBeUndefined();
        expect(registry.entries()).toEqual([]);
      }),
    );

    test(
      "retire then resume then get yields a registered instance and clears the mark",
      withHarness((registry) => {
        const first = registry.get("dev-1", () => ({}));
        registry.retire("dev-1");
        expect(registry.isRetired("dev-1")).toBe(true);
        registry.resume("dev-1");
        expect(registry.isRetired("dev-1")).toBe(false);
        expect(registry.get("dev-1", () => ({}))).toBe(first);
      }),
    );

    test(
      "retire leaves instances in place and is scoped to the device",
      withHarness((registry) => {
        const a = registry.get("dev-1", () => ({}));
        registry.get("dev-2", () => ({}));
        registry.retire("dev-1");
        expect(registry.peek("dev-1")).toBe(a);
        expect(registry.isRetired("dev-2")).toBe(false);
      }),
    );

    test(
      "invalidate drops the instance so the next get creates a new one",
      withHarness((registry) => {
        const first = registry.get("dev-1", () => ({}));
        expect(registry.invalidate("dev-1")).toBe(true);
        expect(registry.invalidate("dev-1")).toBe(false);
        expect(registry.get("dev-1", () => ({}))).not.toBe(first);
      }),
    );

    test(
      "invalidate with a stale instance leaves the replacement",
      withHarness((registry) => {
        const stale = registry.get("dev-1", () => ({}));
        registry.invalidate("dev-1");
        const current = registry.get("dev-1", () => ({}));
        expect(registry.invalidate("dev-1", stale)).toBe(false);
        expect(registry.peek("dev-1")).toBe(current);
        expect(registry.invalidate("dev-1", current)).toBe(true);
        expect(registry.peek("dev-1")).toBeUndefined();
      }),
    );

    test(
      "closeAll returns and drops every instance but keeps retired marks",
      withHarness((registry) => {
        const a = registry.get("dev-1", () => ({}));
        const b = registry.get("dev-2", () => ({}));
        registry.retire("dev-1");
        const drained = registry.closeAll();
        expect(drained).toHaveLength(2);
        expect(drained).toContain(a);
        expect(drained).toContain(b);
        expect(registry.entries()).toEqual([]);
        expect(registry.isRetired("dev-1")).toBe(true);
      }),
    );

    test(
      "clearRetired clears every mark without dropping instances",
      withHarness((registry) => {
        const a = registry.get("dev-1", () => ({}));
        registry.retire("dev-1");
        registry.retire("dev-2");
        registry.clearRetired();
        expect(registry.isRetired("dev-1")).toBe(false);
        expect(registry.isRetired("dev-2")).toBe(false);
        expect(registry.peek("dev-1")).toBe(a);
      }),
    );

    test(
      "entries lists registered pairs",
      withHarness((registry) => {
        const a = registry.get("dev-1", () => ({}));
        expect(registry.entries()).toEqual([["dev-1", a]]);
      }),
    );
  });
}
