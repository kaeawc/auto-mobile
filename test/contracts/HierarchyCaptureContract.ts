import { describe, expect, test } from "bun:test";
import {
  getHierarchySnapshot,
  type HierarchyCapture,
} from "../../src/features/observe/HierarchyCapture";
import type { ViewHierarchyResult } from "../../src/models";
import { ActionableError } from "../../src/models/ActionableError";

/** What each implementation supplies: the capture under test and a way to script what the device returns. */
export interface ScriptedHierarchyCapture {
  capture: HierarchyCapture;
  /** Every capture reads this hierarchy until scripted again; the same object is returned each time. */
  script(hierarchy: ViewHierarchyResult): void;
  /** The host clock the capture stamps `receivedAt` from when the device sent none. */
  hostNow: number;
}

const tree = (updatedAt: number, label = "Target"): ViewHierarchyResult => ({
  updatedAt,
  hierarchy: {
    node: { text: label, clickable: true, bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
  },
});

/**
 * Shared behavioural contract for {@link HierarchyCapture} (#11868): the real
 * DefaultHierarchyCapture (reader seam scripted) and FakeHierarchyCapture agree on snapshot
 * identity, freshness echo, abort, device errors, the timestamp floor and provenance.
 */
export function runHierarchyCaptureContract(name: string, make: () => ScriptedHierarchyCapture) {
  describe(`HierarchyCapture contract: ${name}`, () => {
    test("snapshot echoes the requested freshness and projects searchable nodes", async () => {
      const scripted = make();
      scripted.script(tree(100));
      const snapshot = await scripted.capture.capture({ freshness: "fresh" });
      expect(snapshot.requestedFreshness).toBe("fresh");
      expect(snapshot.updatedAt).toBe(100);
      expect(snapshot.nodes.length).toBeGreaterThan(0);
      expect(snapshot.nodes[0].bounds?.right).toBe(10);
    });

    test("a capture of the same source object reuses its identity and nodes", async () => {
      const scripted = make();
      scripted.script(tree(100));
      const first = await scripted.capture.capture({ freshness: "cached-ok" });
      const second = await scripted.capture.capture({ freshness: "cached-ok" });
      expect(second.captureId).toBe(first.captureId);
      expect(second.nodes).toBe(first.nodes);
    });

    test("a new source object gets a new identity", async () => {
      const scripted = make();
      scripted.script(tree(100));
      const first = await scripted.capture.capture({ freshness: "cached-ok" });
      scripted.script(tree(200));
      const second = await scripted.capture.capture({ freshness: "fresh" });
      expect(second.captureId).not.toBe(first.captureId);
      expect(second.updatedAt).toBe(200);
    });

    test("receivedAt comes from the device read, else the host clock", async () => {
      const scripted = make();
      scripted.script({ ...tree(100), receivedAt: 4242 });
      expect((await scripted.capture.capture({ freshness: "fresh" })).receivedAt).toBe(4242);
      scripted.script(tree(100));
      expect((await scripted.capture.capture({ freshness: "fresh" })).receivedAt).toBe(
        scripted.hostNow,
      );
    });

    test("an already aborted request rejects", async () => {
      const scripted = make();
      scripted.script(tree(100));
      const controller = new AbortController();
      controller.abort();
      await expect(
        scripted.capture.capture({ freshness: "fresh", signal: controller.signal }),
      ).rejects.toThrow();
    });

    test("a hierarchy the device reports as errored is an ActionableError", async () => {
      const scripted = make();
      scripted.script({ hierarchy: { error: "root unavailable" } });
      const failure = await scripted.capture.capture({ freshness: "fresh" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ActionableError);
      expect((failure as Error).message).toContain("root unavailable");
    });

    test("a capture older than minTimestamp is refused, a newer one accepted", async () => {
      const scripted = make();
      scripted.script(tree(100));
      await expect(
        scripted.capture.capture({ freshness: "fresh", minTimestamp: 101 }),
      ).rejects.toBeInstanceOf(ActionableError);
      const snapshot = await scripted.capture.capture({ freshness: "fresh", minTimestamp: 100 });
      expect(snapshot.updatedAt).toBe(100);
    });

    test("a capture without a device timestamp cannot satisfy a floor", async () => {
      const scripted = make();
      scripted.script({ hierarchy: { node: { text: "x" } } });
      await expect(
        scripted.capture.capture({ freshness: "fresh", minTimestamp: 1 }),
      ).rejects.toBeInstanceOf(ActionableError);
    });

    test("the snapshot hierarchy resolves back to the snapshot", async () => {
      const scripted = make();
      scripted.script(tree(100));
      const snapshot = await scripted.capture.capture({ freshness: "fresh" });
      expect(getHierarchySnapshot(snapshot.hierarchy)?.captureId).toBe(snapshot.captureId);
    });
  });
}
