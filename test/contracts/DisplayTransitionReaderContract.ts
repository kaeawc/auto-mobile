import { describe, expect, test } from "bun:test";
import type { DisplayTransitionReader } from "../../src/features/observe/DisplayTransition";

export interface DisplayTransitionReaderContractHarness {
  reader: DisplayTransitionReader;
  /** A panel or posture change: advances the full revision and the identity generation. */
  transition(deviceId: string): void;
  /** A fresh observation accepted this panel at the current revision. */
  observe(deviceId: string, panel: { key: string; role: "inner" | "cover" }): void;
  /** A geometry correction within one observation: the revision moves, identity does not. */
  resize(deviceId: string): void;
}

/**
 * Shared contract for every {@link DisplayTransitionReader}, the read-only fence behind
 * coordinate actions. Run against the real DisplayTransitionTracker and
 * FakeDisplayTransitionReader so a fake cannot accept a stale rendered revision, report a
 * panel nothing has observed since the last transition, or leak one device's fence into
 * another (issue #11868).
 */
export const runDisplayTransitionReaderContract = (
  description: string,
  make: () => DisplayTransitionReaderContractHarness,
): void => {
  describe(`DisplayTransitionReader contract: ${description}`, function () {
    test("a transition advances both the revision and the identity generation", function () {
      const { reader, transition } = make();
      const revision = reader.revision("a");
      const generation = reader.identityRevision("a");

      transition("a");

      expect(reader.revision("a")).toBe(revision + 1);
      expect(reader.identityRevision("a")).toBe(generation + 1);
    });

    test("a rendered revision stays valid until an identity transition passes it", function () {
      const { reader, transition } = make();
      const rendered = reader.revision("a");
      expect(reader.sameIdentitySince("a", rendered)).toBe(true);

      transition("a");

      expect(reader.sameIdentitySince("a", rendered)).toBe(false);
      expect(reader.sameIdentitySince("a", reader.revision("a"))).toBe(true);
    });

    test("a revision from the future never matches", function () {
      const { reader } = make();

      expect(reader.sameIdentitySince("a", reader.revision("a") + 1)).toBe(false);
    });

    test("a geometry correction keeps an earlier render on the same identity", function () {
      const { reader, observe, resize } = make();
      observe("a", { key: "inner", role: "inner" });
      const rendered = reader.revision("a");
      const generation = reader.identityRevision("a");

      resize("a");

      expect(reader.revision("a")).toBe(rendered + 1);
      expect(reader.identityRevision("a")).toBe(generation);
      expect(reader.sameIdentitySince("a", rendered)).toBe(true);
      expect(reader.currentObservedPanel("a")).toEqual({ key: "inner", role: "inner" });
    });

    test("an observed panel is current until the next transition fences it", function () {
      const { reader, observe, transition } = make();
      observe("a", { key: "inner", role: "inner" });
      expect(reader.currentObservedPanel("a")).toEqual({ key: "inner", role: "inner" });

      transition("a");
      expect(reader.currentObservedPanel("a")).toBeUndefined();

      observe("a", { key: "cover", role: "cover" });
      expect(reader.currentObservedPanel("a")).toEqual({ key: "cover", role: "cover" });
    });

    test("a transition on one device leaves another device's fence alone", function () {
      const { reader, observe, transition } = make();
      observe("a", { key: "inner", role: "inner" });
      observe("b", { key: "inner", role: "inner" });
      const revisionB = reader.revision("b");
      const generationB = reader.identityRevision("b");

      transition("a");

      expect(reader.revision("b")).toBe(revisionB);
      expect(reader.identityRevision("b")).toBe(generationB);
      expect(reader.sameIdentitySince("b", revisionB)).toBe(true);
      expect(reader.currentObservedPanel("b")).toEqual({ key: "inner", role: "inner" });
    });
  });
};
