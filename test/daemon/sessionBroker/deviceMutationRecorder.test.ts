import { logger } from "../../../src/utils/logger";
import { opaqueIntentKey } from "../../../src/daemon/sessionBroker/mutations/types";
import { describe, expect, spyOn, test } from "bun:test";
import {
  brokerSessionMutationScope,
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

  test("broker Android keys fence native replacements and boots, not assignment generations", () => {
    const input = {
      platform: "android",
      sessionUuid: "session",
      resource: { resourceId: "resource-1", scopeKey: "pool", allocationIndex: 0 },
      stableDeviceId: "avd",
      assignmentGeneration: 2,
    };
    const scope = brokerSessionMutationScope(input);
    expect(scope.incarnation).toBe('["resource-1","avd",null]');
    expect(brokerSessionMutationScope({ ...input, assignmentGeneration: 3 })).toEqual(scope);
    expect(
      brokerSessionMutationScope({ ...input, stableDeviceId: "replacement" }).incarnation,
    ).not.toBe(scope.incarnation);
    expect(brokerSessionMutationScope({ ...input, bootId: "boot" }).incarnation).not.toBe(
      scope.incarnation,
    );
    for (const assignmentGeneration of [null, NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => brokerSessionMutationScope({ ...input, assignmentGeneration })).toThrow(
        "exact resource and assignment generation",
      );
    }
    // Assignment generation is Android-only validation.
    expect(() =>
      brokerSessionMutationScope({ ...input, platform: "ios", assignmentGeneration: null }),
    ).not.toThrow();
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

test("markUnrecorded persists a fallback row and warns when its own write fails", async () => {
  const journal = new FakeDeviceMutationJournal(new FakeTimer());
  const scope = { sessionUuid: "session", deviceId: "device", incarnation: "native" };
  const recorder = new SessionMutationRecorder(journal, scope);
  await recorder.markUnrecorded("clipboard");
  expect(await journal.list(scope)).toMatchObject([
    {
      kind: "opaque",
      key: opaqueIntentKey("recording-failed", "clipboard"),
      priorValue: { state: "unobservable" },
      toolName: "clipboard",
    },
  ]);
  journal.record = async () => {
    throw new Error("journal unavailable");
  };
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await expect(recorder.markUnrecorded("clipboard")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});
