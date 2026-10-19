import { describe, expect, test } from "bun:test";
import {
  FinalizedRecordingOwners,
  MAX_FINALIZED_RECORDING_OWNERS,
} from "../../../src/daemon/proxy/FinalizedRecordingOwners";

function setup(held: string[]) {
  const heldSet = new Set(held);
  const ledger = new FinalizedRecordingOwners({ holdsSession: (id) => heldSet.has(id) });
  return { ledger, heldSet };
}

const stop = (recordingId: unknown) => ({ action: "stop", recordingId });

describe("FinalizedRecordingOwners", () => {
  test("remembers recordings of a held session and names their starter", () => {
    const { ledger } = setup(["s1"]);
    ledger.remember("s1", ["r1", "r2"]);
    expect(ledger.retrievalOwner("videoRecording", stop("r1"))).toBe("s1");
    expect(ledger.retrievalOwner("videoRecording", stop("r2"))).toBe("s1");
  });

  test("ignores sessions this proxy never held and empty id lists", () => {
    const { ledger } = setup(["s1"]);
    ledger.remember("other", ["r1"]);
    ledger.remember("s1", []);
    ledger.remember("s1", undefined);
    expect(ledger.size).toBe(0);
    expect(ledger.retrievalOwner("videoRecording", stop("r1"))).toBeUndefined();
  });

  test("a labelled session is held through its base id", () => {
    const { ledger } = setup(["base"]);
    ledger.remember("base:label", ["r1"]);
    expect(ledger.retrievalOwner("videoRecording", stop("r1"))).toBe("base:label");
  });

  test("a leading colon does not fall back to an empty base", () => {
    const { ledger } = setup([""]);
    ledger.remember(":label", ["r1"]);
    expect(ledger.size).toBe(0);
  });

  test("only videoRecording stop with a string id is a retrieval", () => {
    const { ledger } = setup(["s1"]);
    ledger.remember("s1", ["r1"]);
    expect(ledger.retrievalOwner("tapOn", stop("r1"))).toBeUndefined();
    expect(ledger.retrievalOwner("videoRecording", { action: "start", recordingId: "r1" })).toBe(
      undefined,
    );
    expect(ledger.retrievalOwner("videoRecording", stop(7))).toBeUndefined();
    expect(ledger.retrievalOwner("videoRecording", stop("unknown"))).toBeUndefined();
  });

  test("re-remembering an id moves it to the newest slot and updates its owner", () => {
    const { ledger } = setup(["s1", "s2"]);
    ledger.remember("s1", ["r1"]);
    ledger.remember("s2", ["r1"]);
    expect(ledger.retrievalOwner("videoRecording", stop("r1"))).toBe("s2");
    expect(ledger.size).toBe(1);
  });

  test("evicts the oldest ids beyond the cap", () => {
    const { ledger } = setup(["s1"]);
    const ids = Array.from({ length: MAX_FINALIZED_RECORDING_OWNERS + 2 }, (_, i) => `r${i}`);
    ledger.remember("s1", ids);
    expect(ledger.size).toBe(MAX_FINALIZED_RECORDING_OWNERS);
    expect(ledger.retrievalOwner("videoRecording", stop("r0"))).toBeUndefined();
    expect(ledger.retrievalOwner("videoRecording", stop("r1"))).toBeUndefined();
    expect(ledger.retrievalOwner("videoRecording", stop("r2"))).toBe("s1");
  });
});
