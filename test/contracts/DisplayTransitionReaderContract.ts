import { describe, expect, test } from "bun:test";
import type { DisplayTransitionReader } from "../../src/features/observe/DisplayTransition";

export interface DisplayTransitionReaderSubject {
  reader: DisplayTransitionReader;
  /** A panel/posture change: advances the full revision and the identity fence. */
  identityTransition: () => void;
  /** A geometry-only correction: advances the full revision, not the identity fence. */
  geometryTransition: () => void;
}

const DEVICE = "contract-device";

/**
 * Behaviour every DisplayTransitionReader must share. Values are compared relative to
 * the reader's own starting revisions: a fake may start at an arbitrary revision, but
 * the "since" fence must treat that starting revision as current, not as stale.
 */
export function runDisplayTransitionReaderContract(
  name: string,
  create: () => DisplayTransitionReaderSubject,
): void {
  describe(`${name} DisplayTransitionReader contract`, () => {
    test("the revision a reader starts at is the same identity since itself", () => {
      const { reader } = create();
      expect(reader.sameIdentitySince(DEVICE, reader.revision(DEVICE))).toBe(true);
    });

    test("a revision from the future is never the same identity", () => {
      const { reader } = create();
      expect(reader.sameIdentitySince(DEVICE, reader.revision(DEVICE) + 1)).toBe(false);
    });

    test("an identity transition invalidates every older rendered revision", () => {
      const { reader, identityTransition } = create();
      const rendered = reader.revision(DEVICE);
      const generation = reader.identityRevision(DEVICE);
      identityTransition();
      expect(reader.revision(DEVICE)).toBeGreaterThan(rendered);
      expect(reader.identityRevision(DEVICE)).toBeGreaterThan(generation);
      expect(reader.sameIdentitySince(DEVICE, rendered)).toBe(false);
      expect(reader.sameIdentitySince(DEVICE, reader.revision(DEVICE))).toBe(true);
    });

    test("a geometry-only transition keeps older rendered revisions on the same identity", () => {
      const { reader, geometryTransition } = create();
      const rendered = reader.revision(DEVICE);
      const generation = reader.identityRevision(DEVICE);
      geometryTransition();
      expect(reader.revision(DEVICE)).toBeGreaterThan(rendered);
      expect(reader.identityRevision(DEVICE)).toBe(generation);
      expect(reader.sameIdentitySince(DEVICE, rendered)).toBe(true);
    });

    test("a revision rendered before an identity change stays stale after later geometry changes", () => {
      const { reader, identityTransition, geometryTransition } = create();
      const beforeIdentity = reader.revision(DEVICE);
      identityTransition();
      const afterIdentity = reader.revision(DEVICE);
      geometryTransition();
      expect(reader.sameIdentitySince(DEVICE, beforeIdentity)).toBe(false);
      expect(reader.sameIdentitySince(DEVICE, afterIdentity)).toBe(true);
    });
  });
}
