import { readGuardFile } from "./astGuard";
import { expect, test } from "bun:test";

import { SessionSlots, type RowPendingSignal } from "../../src/daemon/sessionSlots";

// SessionManager retains this row facet until #11799; slots may only read rowPending.
const rowFacetFields = [
  "pendingTerminalReleaseRetries",
  "lateReleaseWrites",
  "releaseDrainStarted",
  "pendingNonTerminalReleaseSnapshots",
  "owedSupersededRowReasserts",
  "pendingSupersededRowReasserts",
  "supersededRowsUnderPendingRelease",
  "supersededReasonsBeingRewritten",
  "supersededReleaseReasons",
  "releaseReasonPredecessors",
  "refusedReleaseWrites",
  "releaseRowGenerations",
  "persistedRowGenerations",
  "issuedActivityWrites",
  "retiredCreationRows",
  "activityRowRePersists",
  "terminalReleaseRetryBackoff",
  "supersededRowReassertBackoff",
];

test.each(["sessionSlots.ts", "sessionSlotShadowProbe.ts", "legacyLifecycleView.ts"])(
  "%s never names a row-facet field",
  (file) => {
    const source = readGuardFile(new URL(`../../src/daemon/${file}`, import.meta.url));
    for (const field of rowFacetFields) {
      expect(source).not.toContain(field);
    }
  },
);

test("rowPending defaults to false for every UUID", () => {
  const slots = new SessionSlots();
  for (const uuid of ["", "missing", "00000000-0000-0000-0000-000000000000"]) {
    expect(slots.rowPending(uuid)).toBe(false);
  }
});

class FakeRowPendingSignal implements RowPendingSignal {
  readonly pendingIds = new Set<string>();
  readonly reads: string[] = [];

  pending(uuid: string): boolean {
    this.reads.push(uuid);
    return this.pendingIds.has(uuid);
  }
}

test("rowPending reads the injected signal on every call with the requested UUID", () => {
  const signal = new FakeRowPendingSignal();
  const slots = new SessionSlots({ rowPending: signal });
  expect(signal.reads).toEqual([]);
  expect(slots.rowPending("first")).toBe(false);
  signal.pendingIds.add("first");
  expect(slots.rowPending("first")).toBe(true);
  expect(slots.rowPending("second")).toBe(false);
  signal.pendingIds.delete("first");
  expect(slots.rowPending("first")).toBe(false);
  expect(signal.reads).toEqual(["first", "first", "second", "first"]);
});
