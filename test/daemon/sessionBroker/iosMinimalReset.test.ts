import { describe, expect, test } from "bun:test";
import { IosMinimalReset } from "../../../src/daemon/sessionBroker/iosMinimalReset";
import type { IosResetProfile } from "../../../src/daemon/sessionBroker/iosResetTarget";
import { InMemoryMutationRecordingGaps } from "../../../src/daemon/sessionBroker/mutations/recordingGaps";
import { ActionableError } from "../../../src/models/ActionableError";
import { FakeDeviceMutationJournal } from "../../fakes/FakeDeviceMutationJournal";
import { FakeDeviceMutationResetPort } from "../../fakes/FakeDeviceMutationResetPort";
import { FakeTimer } from "../../fakes/FakeTimer";

const PROFILE: IosResetProfile = {
  platform: "ios",
  metadataState: "current",
  simulatorDeviceTypeIdentifier: "iphone",
  archetype: "phone",
  modelType: { family: "iphone", variant: "pro" },
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
  osVersion: "27",
  compatibility: "supported",
};
const DEVICE = { deviceId: "UDID", platform: "ios", name: "phone" } as const;
const SCOPE = { deviceId: DEVICE.deviceId, incarnation: "generation-1", sessionUuid: "session-a" };

async function harness(options: { maxUses?: number } = {}) {
  const timer = new FakeTimer();
  const journal = new FakeDeviceMutationJournal(timer);
  const calls: string[] = [];
  const mutations = new FakeDeviceMutationResetPort({
    completeKinds: [],
    observations: [],
    unobservable: [],
  });
  const originalRevert = mutations.revert.bind(mutations);
  mutations.revert = async (mutation, context) => {
    calls.push(`revert:${mutation.kind}:${mutation.key}`);
    await originalRevert(mutation, context);
  };
  const state = { failOn: undefined as string | undefined, owned: true };
  const simctl = {
    executeCommandArgs: async (args: string[]) => {
      calls.push(args.join(" "));
      return {
        stdout: "",
        stderr: "",
        error:
          state.failOn !== undefined && args.join(" ").includes(state.failOn) ? "boom" : undefined,
      };
    },
  } as never;
  const recordingGaps = new InMemoryMutationRecordingGaps();
  const reset = new IosMinimalReset({
    timer,
    journal,
    mutations,
    simctl,
    recordingGaps,
    maxUses: options.maxUses ?? 5,
    budgetMs: 50,
  });
  const run = (reuseCount = 0) =>
    reset.resetWithTiming(
      DEVICE,
      PROFILE,
      async () => {
        if (!state.owned) {
          throw new ActionableError("Ownership lost");
        }
      },
      SCOPE,
      reuseCount,
    );
  return { journal, calls, mutations, state, run, recordingGaps };
}

const installed = (key: string) => ({
  kind: "installed-app" as const,
  key,
  priorValue: { state: "absent" as const },
  toolName: "installApp",
});

describe("IosMinimalReset", () => {
  test("uninstalls session apps then resets keychain, privacy, appearance, content size and pasteboard in order", async () => {
    const { journal, calls, run } = await harness();
    await journal.record(SCOPE, installed("com.example.one"));
    await journal.record(SCOPE, installed("com.example.two"));
    const outcome = await run();
    expect(outcome).toMatchObject({ outcome: "clean", mode: "minimal" });
    expect(calls).toEqual([
      "revert:installed-app:com.example.two",
      "revert:installed-app:com.example.one",
      "keychain UDID reset",
      "privacy UDID reset all",
      "ui UDID appearance light",
      "ui UDID content_size large",
      "revert:clipboard:pasteboard",
    ]);
    expect(await journal.list(SCOPE)).toEqual([]);
  });

  test("writes an empty pasteboard", async () => {
    const { mutations, run } = await harness();
    await run();
    expect(mutations.reverted.at(-1)?.priorValue).toEqual({ state: "present", value: "" });
  });

  test.each(["keychain", "privacy", "appearance", "content_size"])(
    "a failing %s step returns pending without erase and keeps later steps unrun",
    async (failOn) => {
      const { journal, calls, state, run } = await harness();
      await journal.record(SCOPE, installed("com.example.one"));
      state.failOn = failOn;
      const outcome = await run();
      expect(outcome).toMatchObject({ outcome: "pending", mode: "minimal" });
      expect(outcome.fallbackReason).toContain("boom");
      expect(calls.some((call) => call.startsWith("erase"))).toBe(false);
      expect(calls.at(-1)).toContain(failOn);
      expect(await journal.list(SCOPE)).toHaveLength(1);
    },
  );

  test("a failing uninstall returns pending and stops before the keychain reset", async () => {
    const { journal, calls, mutations, run } = await harness();
    await journal.record(SCOPE, installed("com.example.one"));
    mutations.beforeWrite = async () => {
      throw new ActionableError("uninstall failed");
    };
    const outcome = await run();
    expect(outcome).toMatchObject({ outcome: "pending", mode: "minimal" });
    expect(outcome.fallbackReason).toBe("uninstall failed");
    expect(calls).toEqual(["revert:installed-app:com.example.one"]);
  });

  test("a recorded failure is repeated on redrive without cleaning again", async () => {
    const { calls, state, run } = await harness();
    state.failOn = "keychain";
    await run();
    const seen = calls.length;
    state.failOn = undefined;
    const outcome = await run();
    expect(outcome.outcome).toBe("pending");
    expect(calls).toHaveLength(seen);
  });

  test("retires the simulator on the maxUses-th release without running any step", async () => {
    const { calls, run } = await harness({ maxUses: 3 });
    expect((await run(1)).outcome).toBe("clean");
    const callsAfterClean = calls.length;
    const outcome = await run(2);
    expect(outcome).toMatchObject({ outcome: "pending", fallbackReason: "maxUses reached" });
    expect(calls).toHaveLength(callsAfterClean);
  });

  test("an incomplete recording makes the session's apps unknown, so the simulator is destroyed", async () => {
    const { calls, recordingGaps, run } = await harness();
    recordingGaps.mark(SCOPE.sessionUuid, "journal write failed");
    const outcome = await run();
    expect(outcome.outcome).toBe("pending");
    expect(outcome.fallbackReason).toContain("journal write failed");
    expect(calls).toEqual([]);
  });

  test("lost ownership aborts instead of returning a destroy outcome", async () => {
    const { state, run } = await harness();
    state.owned = false;
    await expect(run()).rejects.toThrow("Ownership lost");
  });

  test("rejects a non-positive maxUses", async () => {
    const timer = new FakeTimer();
    expect(
      () =>
        new IosMinimalReset({
          timer,
          journal: new FakeDeviceMutationJournal(timer),
          mutations: new FakeDeviceMutationResetPort({
            completeKinds: [],
            observations: [],
            unobservable: [],
          }),
          simctl: {} as never,
          maxUses: 0,
        }),
    ).toThrow("maxUses");
  });
});
