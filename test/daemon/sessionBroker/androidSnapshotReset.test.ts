import { describe, expect, test } from "bun:test";
import { AndroidSnapshotReset } from "../../../src/daemon/sessionBroker/androidSnapshotReset";
import {
  AndroidBaselineReset,
  type AndroidResetContext,
} from "../../../src/daemon/sessionBroker/androidBaselineReset";
import { AndroidBootAdmissionGate } from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { FakeAndroidCapacitySource } from "../../fakes/FakeAndroidCapacitySource";
import {
  FakeHostBootAdmissionRegistry,
  SharedBootAdmissionHostState,
} from "../../fakes/FakeHostBootAdmissionRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAndroidSnapshotPort } from "./fixtures/androidSnapshotReset";
import {
  ANDROID_RESET_DEVICE,
  ANDROID_RESET_PROFILE,
  FakeAndroidResetHost,
} from "./fixtures/androidReset";
import { drainUntil } from "../../helpers/fakeTimerStepping";
import type { BootSlotReservation } from "../../../src/devices/bootAdmission/BootSlotReservation";
import { ResetFailureError } from "../../../src/daemon/sessionBroker/ResetFailureError";

function rig() {
  const timer = new FakeTimer();
  const port = new FakeAndroidSnapshotPort();
  const incarnations: string[] = [];
  const strategy = new AndroidSnapshotReset(port, timer, {
    prepareForIncarnationChange: async () => {
      incarnations.push("prepare");
    },
    invalidate: async () => {
      incarnations.push("invalidate");
    },
    settleIncarnationChange: async (_device, { ready }) => {
      incarnations.push(`settle:${ready}`);
    },
  });
  const controller = new AbortController();
  const context: AndroidResetContext = {
    fresh: true,
    resourceId: "resource-a",
    signal: controller.signal,
    timeoutMs: 30_000,
    assertOwned: async () => {},
  };
  const reset = () => strategy.reset(ANDROID_RESET_DEVICE, new Set(), context.assertOwned, context);
  return { timer, port, strategy, context, controller, reset, incarnations };
}

describe("AndroidSnapshotReset", () => {
  test.each([false, true])(
    "reports native phase timings with failed load=%s",
    async (failedLoad) => {
      const { strategy, port, context, reset, timer } = rig();
      await strategy.capture(ANDROID_RESET_DEVICE, context);
      if (failedLoad) {
        port.failures.add("load");
      }
      port.onStep = async () => {
        timer.advanceTime(3);
      };
      const outcome = await reset();
      expect(outcome).toEqual({
        outcome: failedLoad ? "fallback:wipe-data" : "clean",
        mode: failedLoad ? "wipe-data" : "snapshot",
        ...(failedLoad ? { fallbackReason: "load failed" } : {}),
        phases: failedLoad
          ? {
              identity: 3,
              "prepare incarnation": 0,
              load: 3,
              invalidate: 3,
              "reserve replacement boot": 0,
              stop: 3,
              "wipe-data launch": 3,
              readiness: 3,
              "wipe-data health": 3,
              "wipe-data identity": 3,
              save: 3,
              "saved identity": 3,
            }
          : {
              identity: 3,
              "prepare incarnation": 0,
              load: 3,
              "restore readiness": 3,
              health: 3,
              "restored identity": 3,
            },
      });
    },
  );

  test("failed replacement preserves partial phase timings and load failure reason", async () => {
    const { strategy, port, context, reset, timer } = rig();
    await strategy.capture(ANDROID_RESET_DEVICE, context);
    port.failures.add("load");
    port.failures.add("launch");
    port.onStep = async () => {
      timer.advanceTime(4);
    };
    const failure = await reset().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ResetFailureError);
    expect(failure).toMatchObject({
      message: "Android snapshot baseline reset failed; destroy required: launch failed",
      reset: {
        outcome: "pending",
        mode: "wipe-data",
        fallbackReason: "load failed",
        phases: { identity: 4, load: 4, stop: 4, "wipe-data launch": 4 },
      },
    });
    expect((failure as ResetFailureError).reset.phases).not.toHaveProperty("readiness");
  });

  test("baseline deadline retains partial native phases", async () => {
    const { strategy, port, timer } = rig();
    const host = new FakeAndroidResetHost();
    host.strategy = strategy;
    host.timer = timer;
    host.resetTimeoutMs = 10;
    const baseline = new AndroidBaselineReset(host);
    await baseline.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-a", {
      stableDeviceId: "stable-avd",
      timer,
      fresh: true,
      timeoutMs: 30_000,
      assertOwned: async () => {},
    });
    port.onStep = async (action) => {
      if (action === "load") {
        await new Promise<void>(() => {});
      } else {
        timer.advanceTime(2);
      }
    };
    const result = baseline.reset(
      "resource-a",
      ANDROID_RESET_DEVICE,
      ANDROID_RESET_PROFILE,
      async () => {},
    );
    const failure = result.catch((error: unknown) => error);
    await drainUntil(() => port.calls.at(-1) === "load", { description: "snapshot load" });
    timer.advanceTime(8);
    expect(await failure).toBeInstanceOf(ResetFailureError);
    expect(await failure).toMatchObject({
      reset: { outcome: "pending", mode: "snapshot", phases: { identity: 2, load: 8 } },
    });
  });

  test("warm restore prepares, invalidates and settles host state after readiness", async () => {
    const { strategy, port, context, reset, incarnations } = rig();
    await strategy.capture(ANDROID_RESET_DEVICE, context);
    port.onStep = async (action) => {
      if (action === "load") {
        expect(incarnations).toEqual(["prepare"]);
      }
      if (action === "restore ready") {
        expect(incarnations).toEqual(["prepare", "invalidate"]);
      }
      if (action === "health") {
        expect(port.calls.at(-2)).toBe("restore ready");
      }
    };
    await reset();
    expect(incarnations).toEqual(["prepare", "invalidate", "settle:true"]);
  });

  test("failed load settles unready host state before replacement and advances the replacement", async () => {
    const { strategy, port, context, reset, incarnations } = rig();
    await strategy.capture(ANDROID_RESET_DEVICE, context);
    port.failures.add("load");
    port.onStep = async (action) => {
      if (action === "stop") {
        expect(incarnations).toEqual(["prepare", "invalidate", "settle:false", "prepare"]);
      }
      if (action === "launch") {
        expect(incarnations.at(-1)).toBe("invalidate");
      }
    };
    await reset();
    expect(incarnations).toEqual([
      "prepare",
      "invalidate",
      "settle:false",
      "prepare",
      "invalidate",
      "settle:true",
    ]);
  });
  test("adopted or recovered devices cannot be blessed as a first clean baseline", async () => {
    const { strategy, port, context } = rig();
    context.fresh = false;
    await expect(strategy.capture(ANDROID_RESET_DEVICE, context)).rejects.toThrow(
      "unqualified adoption",
    );
    expect(port.calls).not.toContain("save");
  });
  test("changed capture identity invalidates and recaptures rather than keeping an old snapshot", async () => {
    const { strategy, port, context } = rig();
    await strategy.capture(ANDROID_RESET_DEVICE, context);
    port.currentIdentity.emulatorVersion = "upgraded";
    await strategy.capture(ANDROID_RESET_DEVICE, context);
    expect(port.calls.filter((call) => call === "save")).toHaveLength(2);
    expect(port.calls).toContain("delete");
  });

  test("failed old-snapshot deletion still attempts the wipe-data fallback", async () => {
    const { strategy, port, context, reset } = rig();
    await strategy.capture(ANDROID_RESET_DEVICE, context);
    port.failures.add("load");
    port.failures.add("delete");
    await reset();
    expect(port.calls).toContain("launch");
    expect(port.calls.filter((call) => call === "save")).toHaveLength(2);
  });

  test("ownership loss during replacement reservation releases the unused slot", async () => {
    const { port, context, reset } = rig();
    let owned = true;
    let released = false;
    context.assertOwned = async () => {
      if (!owned) {
        throw new Error("ownership lost");
      }
    };
    port.capacity = {
      reserveBoot: async () => {
        owned = false;
        return {
          run: async (operation) => operation(),
          markReplacedDeviceGone: () => {},
          release: () => {
            released = true;
          },
        };
      },
    };
    await expect(reset()).rejects.toThrow("ownership lost");
    expect(released).toBe(true);
    expect(port.calls).not.toContain("stop");
  });

  test("a reservation returning after deadline is released without stopping the emulator", async () => {
    const { port, reset, timer } = rig();
    let complete: ((reservation: BootSlotReservation) => void) | undefined;
    let released = false;
    port.capacity = {
      reserveBoot: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    };
    const result = reset();
    await drainUntil(() => complete !== undefined, { description: "replacement reservation" });
    timer.advanceTime(30_000);
    await expect(result).rejects.toThrow("deadline");
    complete?.({
      run: async (operation) => operation(),
      markReplacedDeviceGone: () => {},
      release: () => {
        released = true;
      },
    });
    await drainUntil(() => released, { description: "late reservation released" });
    expect(port.calls).not.toContain("stop");
  });
  test("captures once per resource and verifies health before successful warm restore", async () => {
    const { strategy, port, context, reset } = rig();
    await strategy.capture(ANDROID_RESET_DEVICE, context);
    await strategy.capture(ANDROID_RESET_DEVICE, context);
    await reset();
    expect(port.calls.filter((call) => call === "save")).toHaveLength(1);
    expect(port.calls.slice(-5)).toEqual([
      "identity",
      "load",
      "restore ready",
      "health",
      "identity",
    ]);
    expect(port.calls).not.toContain("launch");
    expect(port.contexts.every((step) => step.timeoutMs > 0 && !step.signal.aborted)).toBe(true);
  });

  test.each(["avdName", "systemImage", "emulatorVersion", "ctrlProxyVersion"] as const)(
    "mismatched %s takes wipe-data without loading the snapshot",
    async (field) => {
      const { strategy, port, context, reset } = rig();
      await strategy.capture(ANDROID_RESET_DEVICE, context);
      port.currentIdentity[field] = "changed";
      port.calls = [];
      await reset();
      expect(port.calls).not.toContain("load");
      expect(port.calls).toEqual([
        "identity",
        "delete",
        "reserve",
        "stop",
        "launch",
        "ready",
        "health",
        "identity",
        "save",
        "identity",
      ]);
      expect(port.released).toBe(1);
    },
  );

  test("missing baseline takes wipe-data and recaptures", async () => {
    const { port, reset } = rig();
    await reset();
    expect(port.calls).not.toContain("load");
    expect(port.calls).toContain("save");
  });

  test("load failure falls back to wipe-data and the recaptured snapshot is reused", async () => {
    const { strategy, port, context, reset } = rig();
    await strategy.capture(ANDROID_RESET_DEVICE, context);
    port.failures.add("load");
    await reset();
    expect(port.calls).toContain("launch");
    port.failures.clear();
    port.calls = [];
    await reset();
    expect(port.calls).toEqual(["identity", "load", "restore ready", "health", "identity"]);
  });

  test.each(["stop", "launch", "ready", "health", "save"])(
    "load failure followed by %s failure requires destroy",
    async (failure) => {
      const { strategy, port, context, reset } = rig();
      await strategy.capture(ANDROID_RESET_DEVICE, context);
      port.failures.add("load");
      port.failures.add(failure);
      await expect(reset()).rejects.toThrow("destroy required");
      expect(port.released).toBe(1);
    },
  );

  test("failed snapshot health cannot return clean and may recover via wipe-data", async () => {
    const { strategy, port, context, reset } = rig();
    await strategy.capture(ANDROID_RESET_DEVICE, context);
    let healthChecks = 0;
    port.onStep = async (action) => {
      if (action === "health" && ++healthChecks === 1) {
        throw new Error("CtrlProxy or clock is unhealthy");
      }
    };
    await reset();
    expect(healthChecks).toBe(2);
    expect(port.calls).toContain("launch");
  });

  test("ownership loss after load refuses fallback native mutations", async () => {
    const { strategy, port, context, reset } = rig();
    await strategy.capture(ANDROID_RESET_DEVICE, context);
    let owned = true;
    context.assertOwned = async () => {
      if (!owned) {
        throw new Error("ownership lost");
      }
    };
    port.onStep = async (action) => {
      if (action === "load") {
        owned = false;
      }
    };
    await expect(reset()).rejects.toThrow("ownership lost");
    expect(port.calls).not.toContain("stop");
    expect(port.calls).not.toContain("reserve");
  });

  test("deadline aborts a hung load without racing it with wipe-data", async () => {
    const { strategy, port, context, reset, timer } = rig();
    await strategy.capture(ANDROID_RESET_DEVICE, context);
    port.onStep = async (action) => {
      if (action === "load") {
        await new Promise<void>(() => {});
      }
    };
    const result = reset();
    await drainUntil(() => port.calls.at(-1) === "load", { description: "snapshot load dispatch" });
    timer.advanceTime(30_000);
    await expect(result).rejects.toThrow("deadline");
    expect(port.contexts.at(-1)?.signal.aborted).toBe(true);
    expect(port.calls).not.toContain("stop");
  });

  test("external cancellation before capture dispatches no native operations", async () => {
    const { strategy, port, context, controller } = rig();
    controller.abort(new Error("cancelled"));
    await expect(strategy.capture(ANDROID_RESET_DEVICE, context)).rejects.toThrow("cancelled");
    expect(port.calls).toEqual([]);
  });
});

test("replacement gate keeps one charge across stop and same-serial relaunch", async () => {
  const { strategy, port, context, reset, timer } = rig();
  const source = new FakeAndroidCapacitySource();
  source.emulatorSerials = [ANDROID_RESET_DEVICE.deviceId];
  const gate = new AndroidBootAdmissionGate(source, timer, {
    env: { AUTOMOBILE_ANDROID_MAX_BOOTED: "1" },
    hostRegistry: new FakeHostBootAdmissionRegistry(new SharedBootAdmissionHostState(), 100, timer),
  });
  port.capacity = gate;
  await strategy.capture(ANDROID_RESET_DEVICE, context);
  port.failures.add("load");
  port.onStep = async (action) => {
    if (action === "stop") {
      expect(await gate.describeCapacity()).toMatchObject({ booted: 1, inFlight: 0 });
      source.emulatorSerials = [];
    }
    if (action === "launch") {
      expect(await gate.describeCapacity()).toMatchObject({ booted: 0, inFlight: 1 });
      const admission = await gate.admit({
        avdName: ANDROID_RESET_DEVICE.name,
        signal: context.signal,
        timeoutMs: 1000,
      });
      admission.handOff(ANDROID_RESET_DEVICE.deviceId, 4242);
      source.emulatorSerials = [ANDROID_RESET_DEVICE.deviceId];
      expect(await gate.describeCapacity()).toMatchObject({ booted: 1, inFlight: 0 });
    }
  };
  await reset();
});

test("full snapshot strategy restores added packages only when the activity veto permits reset", async () => {
  const { strategy, port, timer } = rig();
  const host = new FakeAndroidResetHost();
  host.strategy = strategy;
  host.timer = timer;
  const baseline = new AndroidBaselineReset(host);
  await baseline.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-a", {
    stableDeviceId: "stable-avd",
    timer,
    fresh: true,
    timeoutMs: 30_000,
    assertOwned: async () => {},
  });
  host.installed.add("com.example.contamination");
  host.safe = true;
  port.onStep = async (action) => {
    if (action === "load") {
      host.installed.delete("com.example.contamination");
    }
  };
  await expect(
    baseline.reset("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
  ).resolves.toMatchObject({ outcome: "clean", mode: "snapshot" });
  expect(host.closed).toBe(1);
});

async function capturedSnapshotRig() {
  const { strategy, port, timer } = rig();
  const host = new FakeAndroidResetHost();
  host.strategy = strategy;
  host.timer = timer;
  const baseline = new AndroidBaselineReset(host);
  await baseline.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-a", {
    stableDeviceId: "stable-avd",
    timer,
    fresh: true,
    timeoutMs: 30_000,
    assertOwned: async () => {},
  });
  const reset = () =>
    baseline.reset("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {});
  return { host, port, reset };
}

test("a session that made mutating tool calls resets by snapshot load, not destroy (#14952)", async () => {
  const { host, port, reset } = await capturedSnapshotRig();
  host.safe = false;
  await expect(reset()).resolves.toMatchObject({ outcome: "clean", mode: "snapshot" });
  expect(port.calls).toContain("load");
  expect(port.calls).not.toContain("launch");
});

test("a session that changed host-side state still destroys rather than reusing the device", async () => {
  const { host, port, reset } = await capturedSnapshotRig();
  host.safe = false;
  host.hostSide = true;
  await expect(reset()).rejects.toThrow("mutations cannot be restored");
  expect(port.calls).not.toContain("load");
  expect(port.calls).not.toContain("launch");
});

test("a session with opaque persistent changes skips the load and takes wipe-data (#14952)", async () => {
  const { host, port, reset } = await capturedSnapshotRig();
  host.safe = false;
  host.opaque = true;
  await expect(reset()).resolves.toMatchObject({
    outcome: "fallback:wipe-data",
    mode: "wipe-data",
    fallbackReason: expect.stringContaining("opaque persistent changes"),
  });
  expect(port.calls).not.toContain("load");
});

test("successful wipe-data reset leaves the replacement launch signal live and captures only once on reacquisition", async () => {
  const { strategy, port, timer } = rig();
  const host = new FakeAndroidResetHost();
  host.strategy = strategy;
  host.timer = timer;
  const baseline = new AndroidBaselineReset(host);
  const capture = () =>
    baseline.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session-a", {
      stableDeviceId: "stable-avd",
      timer,
      fresh: true,
      timeoutMs: 30_000,
      assertOwned: async () => {},
    });
  await capture();
  port.failures.add("load");
  await expect(
    baseline.reset("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
  ).resolves.toMatchObject({
    outcome: "fallback:wipe-data",
    mode: "wipe-data",
    fallbackReason: "load failed",
  });
  const saves = port.calls.filter((call) => call === "save").length;
  expect(port.contexts.every((step) => !step.signal.aborted)).toBe(true);
  await capture();
  expect(port.calls.filter((call) => call === "save")).toHaveLength(saves);
});
