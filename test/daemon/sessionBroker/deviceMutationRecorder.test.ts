import { describe, expect, spyOn, test } from "bun:test";
import {
  brokerMutationIncarnation,
  SessionMutationRecorder,
} from "../../../src/daemon/sessionBroker/mutations/recorder";
import {
  diffDeviceBaseline,
  REQUIRED_BASELINE_KINDS,
} from "../../../src/daemon/sessionBroker/mutations/baseline";
import type { DeviceMutationInput } from "../../../src/daemon/sessionBroker/mutations/types";
import { FakeDeviceMutationJournal } from "../../fakes/FakeDeviceMutationJournal";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("session mutation recorder scope", () => {
  test("injected journal isolates session, device and immutable incarnation", async () => {
    const timer = new FakeTimer();
    const journal = new FakeDeviceMutationJournal(timer);
    const scope = { sessionUuid: "session", deviceId: "phone", incarnation: "native-1" };
    const recorder = new SessionMutationRecorder(journal, scope);
    const mutation: DeviceMutationInput = {
      kind: "clipboard",
      key: "device",
      priorValue: { state: "unobservable" },
      toolName: "clipboard",
    };
    scope.incarnation = "changed";
    await recorder.record(mutation);
    expect(await journal.list(recorder.scope)).toMatchObject([
      { ...mutation, appliedAt: timer.now() },
    ]);
    expect(await journal.list(scope)).toEqual([]);
    expect(await journal.list({ ...recorder.scope, deviceId: "other" })).toEqual([]);
    expect(await journal.list({ ...recorder.scope, sessionUuid: "other" })).toEqual([]);
    expect(Object.isFrozen(recorder.scope)).toBe(true);
  });

  test("unobservable prior observations poison equal before and after baselines", () => {
    const baseline = {
      completeKinds: [...REQUIRED_BASELINE_KINDS],
      observations: [
        { kind: "clipboard", key: "device", value: { state: "unobservable" as const } },
      ],
      unobservable: [],
    };
    const diff = diffDeviceBaseline(baseline, baseline);
    expect(diff.changes).toEqual([]);
    expect(diff.dirty).toEqual([
      "baseline: unobservable clipboard:device",
      "current: unobservable clipboard:device",
    ]);
  });

  test("broker incarnation fences replacement assignment generations", () => {
    expect(brokerMutationIncarnation("resource-1", 2)).toBe('["resource-1",2]');
    expect(brokerMutationIncarnation("resource-1", 2)).not.toBe(
      brokerMutationIncarnation("resource-1", 3),
    );
    expect(brokerMutationIncarnation("resource-1", 2)).not.toBe(
      brokerMutationIncarnation("resource-2", 2),
    );
    expect(() => brokerMutationIncarnation("resource-1", null)).toThrow("exact resource");
    expect(() => brokerMutationIncarnation("resource-1", Number.NaN)).toThrow("exact resource");
  });

  test("missing mutations uses one scoped list and matches kind/key pairs without collisions", async () => {
    const journal = new FakeDeviceMutationJournal(new FakeTimer());
    const scope = { sessionUuid: "session", deviceId: "device", incarnation: "native" };
    const recorder = new SessionMutationRecorder(journal, scope);
    const original: DeviceMutationInput = {
      kind: "a:b",
      key: "c",
      priorValue: { state: "present", value: "original" },
      toolName: "test",
    };
    await recorder.record(original);
    const list = spyOn(journal, "list");
    try {
      const missing = await recorder.missingMutations([
        { kind: "a:b", key: "c" },
        { kind: "a", key: "b:c" },
        { kind: "clipboard", key: "device" },
      ]);
      expect(list).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledWith(scope);
      expect(missing).toEqual([
        { kind: "a", key: "b:c" },
        { kind: "clipboard", key: "device" },
      ]);
      await recorder.record({ ...original, priorValue: { state: "present", value: "changed" } });
      expect(await journal.list(scope)).toMatchObject([{ priorValue: original.priorValue }]);
    } finally {
      list.mockRestore();
    }
  });
});
