import { describe, expect, test } from "bun:test";
import type {
  DeviceBaseline,
  DeviceMutationInput,
} from "../../../src/daemon/sessionBroker/mutations/types";
import { FakeDeviceMutationJournal } from "../../fakes/FakeDeviceMutationJournal";
import { FakeTimer } from "../../fakes/FakeTimer";

const SCOPE = { sessionUuid: "session", deviceId: "phone", incarnation: "generation" };
const MUTATION: DeviceMutationInput = {
  kind: "clipboard",
  key: "device",
  priorValue: { state: "absent" },
  toolName: "clipboard",
};
const BASELINE: DeviceBaseline = { completeKinds: [], observations: [], unobservable: [] };

describe("fake mutation journal validation parity", () => {
  test("every scoped operation rejects blank identities", async () => {
    const journal = new FakeDeviceMutationJournal(new FakeTimer());
    for (const key of ["sessionUuid", "deviceId", "incarnation"] as const) {
      const scope = { ...SCOPE, [key]: " " };
      await expect(journal.record(scope, MUTATION)).rejects.toThrow("non-empty identity");
      await expect(journal.list(scope)).rejects.toThrow("non-empty identity");
      await expect(journal.deleteSession(scope)).rejects.toThrow("non-empty identity");
      if (key !== "sessionUuid") {
        await expect(journal.captureBaseline(scope, BASELINE)).rejects.toThrow(
          "non-empty identity",
        );
        await expect(journal.getBaseline(scope)).rejects.toThrow("non-empty identity");
      }
    }
  });

  test("invalid payloads are rejected even on first-write-wins conflicts", async () => {
    const journal = new FakeDeviceMutationJournal(new FakeTimer());
    const invalidMutation: DeviceMutationInput = {
      ...MUTATION,
      priorValue: { state: "present", value: Number.NaN },
    };
    const invalidBaseline = { ...BASELINE, completeKinds: [""] };
    await expect(journal.record(SCOPE, invalidMutation)).rejects.toThrow();
    await expect(journal.captureBaseline(SCOPE, invalidBaseline)).rejects.toThrow();
    expect(await journal.list(SCOPE)).toEqual([]);
    expect(await journal.getBaseline(SCOPE)).toBeNull();
    await journal.record(SCOPE, MUTATION);
    await journal.captureBaseline(SCOPE, BASELINE);
    await expect(journal.record(SCOPE, invalidMutation)).rejects.toThrow();
    await expect(journal.captureBaseline(SCOPE, invalidBaseline)).rejects.toThrow();
  });
});
