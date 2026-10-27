import { readGuardFile } from "./astGuard";
import { expect, test } from "bun:test";

// #11799 W3: the superseded-row reassert state lives in the row writer's ledger
// (src/daemon/supersededRowReasserts.ts), not in SessionManager.
const movedState = [
  "supersededReleaseReasons",
  "pendingSupersededRowReasserts",
  "supersededRowsUnderPendingRelease",
  "supersededReasonsBeingRewritten",
  "owedSupersededRowReasserts",
  "releaseReasonPredecessors",
  "refusedReleaseWrites",
  "supersededRowReassertBackoff",
  "releaseDrainStarted",
  "interface OwedSupersededRowReassert",
];

test("SessionManager holds none of the superseded-row reassert state", () => {
  const source = readGuardFile(new URL("../../src/daemon/sessionManager.ts", import.meta.url));
  for (const name of movedState) {
    expect(source).not.toContain(name);
  }
});
