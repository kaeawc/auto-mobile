import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  BrokerTimingRecorder,
  pendingAcquisitionTiming,
} from "../../../src/daemon/sessionBroker/timingRecorder";
import { parseTimingReceipt } from "../../../src/daemon/sessionBroker/timingSchema";
import { aggregateBrokerTimings } from "../../../src/daemon/sessionBroker/timingStats";
import { nativeProfile } from "../../../src/daemon/sessionBroker/profile";
import { SessionBroker, RECEIPT_RETENTION_MS } from "../../../src/daemon/sessionBroker/broker";
import type {
  SessionBrokerDevicePort,
  ResetResult,
} from "../../../src/daemon/sessionBroker/devicePort";
import { openExportHarness, exportConfig } from "./fixtures/exportHarness";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ResetFailureError } from "../../../src/daemon/sessionBroker/ResetFailureError";
import { IosKeepBootedReset } from "../../../src/daemon/sessionBroker/iosKeepBootedReset";
import { FakeDeviceMutationJournal } from "../../fakes/FakeDeviceMutationJournal";
import { FakeDeviceMutationResetPort } from "../../fakes/FakeDeviceMutationResetPort";
import { DEVICE_MUTATION_KINDS } from "../../../src/daemon/sessionBroker/mutations/types";
import { drainUntil, drainUntilQuiescent } from "../../helpers/fakeTimerStepping";
import { ResetReadiness } from "../../../src/daemon/sessionBroker/resetReadiness";

describe("durable broker timing", () => {
  let harness: Awaited<ReturnType<typeof openExportHarness>>;
  let broker: SessionBroker;
  let resetResult: ResetResult;

  beforeAll(async () => {
    const warm = await openExportHarness();
    await warm.broker.close();
    await warm.registry.close();
  });
  beforeEach(async () => {
    harness = await openExportHarness(":memory:", new FakeTimer());
    resetResult = { outcome: "clean", mode: "erase", phases: { stop: 3, erase: 5, boot: 7 } };
    const devices: SessionBrokerDevicePort = {
      prepare: async (resource, options) => {
        harness.timer.advanceTime(11);
        const prepared = await harness.devices.prepare(resource, options);
        harness.timer.advanceTime(17);
        return { ...prepared, timing: { createMs: 11, bootMs: 17 } };
      },
      release: (sessionId) => harness.devices.release(sessionId),
      destroy: (resource) => harness.devices.destroy(resource),
      reset: async (resource) => {
        await harness.devices.reset(resource);
        harness.timer.advanceTime(15);
        return resetResult;
      },
    };
    harness.options.devices = devices;
    harness.options.timer = harness.timer;
    harness.options.reuseCleanDevices = true;
    harness.options.limits.idlePoolCap = 1;
    broker = new SessionBroker(harness.options);
  });
  afterEach(async () => {
    await broker.close();
    await harness.broker.close();
    await harness.registry.close();
  });

  test("create and reuse report measured phases and durable reuse counts", async () => {
    const first = await broker.prepare(exportConfig("create"), "token");
    expect(first.timing?.acquisition).toMatchObject({
      admission: "create",
      outcome: "ready",
      reuseCount: 0,
      createMs: 11,
      bootMs: 17,
      totalMs: 28,
    });
    const release = await broker.release(first.sessionUuid!);
    expect(release.timing?.reset).toMatchObject({
      mode: "erase",
      outcome: "clean",
      phases: { stop: 3, erase: 5, boot: 7 },
      totalMs: 15,
      reuseCount: 0,
    });
    expect(release.timing?.acquisition).toEqual(first.timing?.acquisition);
    const second = await broker.prepare(exportConfig("reuse"), "token");
    expect(second.timing?.acquisition).toMatchObject({
      admission: "reuse",
      reuseCount: 1,
      createMs: 0,
      bootMs: 0,
    });
    await broker.release(second.sessionUuid!);
    const third = await broker.prepare(exportConfig("reuse-again"), "token");
    expect(third.timing?.acquisition?.reuseCount).toBe(2);
  });

  test("ports holding the outer reset slot do not receive another slot runner", async () => {
    let resetCalls = 0;
    harness.options.devices.reset = async (_resource, _signal, runResetBoot) => {
      resetCalls++;
      expect(runResetBoot).toBeUndefined();
      return { outcome: "clean", mode: "erase", phases: {} };
    };
    const session = await broker.prepare(exportConfig("outer-slot"), "token");

    await expect(broker.release(session.sessionUuid!)).resolves.toMatchObject({
      outcome: "released",
    });
    expect(resetCalls).toBe(1);
  });

  test("fast resets enter concurrently while their erase fallbacks share one boot slot", async () => {
    const releaseErase = Promise.withResolvers<void>();
    const activity = new Map<string, boolean[]>();
    const setResetActive = ResetReadiness.prototype.setResetActive;
    const tracking = spyOn(ResetReadiness.prototype, "setResetActive").mockImplementation(function (
      this: ResetReadiness,
      resourceId,
      active,
    ) {
      activity.set(resourceId, [...(activity.get(resourceId) ?? []), active]);
      setResetActive.call(this, resourceId, active);
    });
    let fastResets = 0;
    let eraseStarts = 0;
    const devices = harness.options.devices;
    devices.managesResetBootSlots = true;
    devices.reset = async (resource, _signal, runResetBoot) => {
      expect(_signal).toBeUndefined();
      fastResets++;
      if (!runResetBoot) {
        throw new Error("Missing reset boot runner");
      }
      return runResetBoot(async () => {
        eraseStarts++;
        if (eraseStarts === 1) {
          await releaseErase.promise;
        }
        await harness.devices.reset(resource);
        return { outcome: "clean", mode: "erase", phases: {} };
      });
    };
    await broker.close();
    broker = new SessionBroker({
      ...harness.options,
      limits: { totalDeviceCap: 2, sessionCap: 2, idlePoolCap: 2, maxConcurrentResetBoots: 1 },
    });
    const first = await broker.prepare(exportConfig("first"), "token");
    const second = await broker.prepare(exportConfig("second"), "token");
    const releases = [broker.release(first.sessionUuid!), broker.release(second.sessionUuid!)];
    try {
      await drainUntil(() => fastResets === 2, { description: "concurrent fast resets" });
      await drainUntilQuiescent(harness.timer);
      expect(eraseStarts).toBe(1);
      expect([...activity.values()]).toEqual([
        [true, false, true],
        [true, false],
      ]);
    } finally {
      releaseErase.resolve();
      await Promise.all(releases);
      tracking.mockRestore();
    }
    expect(eraseStarts).toBe(2);
    expect([...activity.values()]).toEqual([
      [true, false, true, false],
      [true, false, true, false],
    ]);
  });

  test.each([{ managed: true }, { managed: false }])(
    "reset receipt reports the reset-boot slot wait as its own phase (managed slots: $managed)",
    async ({ managed }) => {
      const releaseErase = Promise.withResolvers<void>();
      let starts = 0;
      const devices = harness.options.devices;
      devices.managesResetBootSlots = managed;
      devices.reset = async (resource, _signal, runResetBoot) => {
        const erase = async () => {
          starts++;
          if (starts === 1) {
            await releaseErase.promise;
          }
          await harness.devices.reset(resource);
          return { outcome: "clean", mode: "erase", phases: {} } as const;
        };
        return managed ? runResetBoot!(erase) : erase();
      };
      await broker.close();
      broker = new SessionBroker({
        ...harness.options,
        limits: { totalDeviceCap: 2, sessionCap: 2, idlePoolCap: 2, maxConcurrentResetBoots: 1 },
      });
      const first = await broker.prepare(exportConfig("first"), "token");
      const second = await broker.prepare(exportConfig("second"), "token");
      const releases = [broker.release(first.sessionUuid!), broker.release(second.sessionUuid!)];
      await drainUntil(() => starts === 1, { description: "first reset holds the boot slot" });
      await drainUntilQuiescent(harness.timer);
      harness.timer.advanceTime(5_000);
      releaseErase.resolve();
      const [firstReleased, secondReleased] = await Promise.all(releases);
      expect(firstReleased.timing?.reset?.phases.bootQueue).toBe(0);
      expect(secondReleased.timing?.reset?.phases.bootQueue).toBe(5_000);
    },
  );

  test("persisted resource use count drives keep-booted retirement on the third release", async () => {
    const journal = new FakeDeviceMutationJournal(harness.timer);
    const mutations = new FakeDeviceMutationResetPort({
      completeKinds: [...DEVICE_MUTATION_KINDS],
      observations: [],
      unobservable: [],
    });
    let erases = 0;
    harness.options.devices.reset = async (resource) => {
      await harness.devices.reset(resource);
      const profile = nativeProfile(resource);
      if (profile.platform !== "ios") {
        throw new Error("Expected iOS");
      }
      const scope = {
        deviceId: "device",
        incarnation: "generation-1",
        sessionUuid: resource.requestId!,
      };
      await journal.captureBaseline(scope, mutations.snapshot);
      const reset = new IosKeepBootedReset({
        journal,
        mutations: Object.assign(mutations, {
          sanitize: async () => {},
          sanitizeCovers: () => false,
          assertSettled: async () => {},
        }),
        timer: harness.timer,
        maxUses: 3,
        health: { probe: async () => true },
        simctl: {
          readSimulatorTarget: async () => ({
            udid: scope.deviceId,
            name: "phone",
            state: "Booted",
            isAvailable: true,
            deviceTypeIdentifier: profile.simulatorDeviceTypeIdentifier,
            runtime: profile.runtimeId,
            os_version: profile.osVersion,
          }),
        },
        erase: {
          resetWithTiming: async () => {
            erases++;
            return { outcome: "clean", mode: "erase", phases: { erase: 1, boot: 2 } };
          },
        },
      });
      return reset.resetWithTiming(
        { deviceId: scope.deviceId, platform: "ios", name: "phone" },
        profile,
        async () => {},
        scope,
        resource.reuseCount ?? 0,
      );
    };
    for (let use = 1; use <= 3; use++) {
      const ready = await broker.prepare(exportConfig(`use-${use}`), "token");
      const released = await broker.release(ready.sessionUuid!);
      expect(released.timing?.reset).toMatchObject({
        reuseCount: use - 1,
        outcome: use === 3 ? "fallback:erase" : "clean",
        mode: use === 3 ? "erase" : "keep-booted",
      });
      const request = await harness.store.getRequest(`use-${use}`);
      const resource = await harness.registry
        .sessionBrokerStore(harness.scopeKey)
        .getResource(request!.resourceId!);
      expect(resource?.reuseCount).toBe(use - 1);
      expect(resource?.state).toBe("idle");
    }
    expect(erases).toBe(1);
  });

  test("keep-booted destroy fallback retires the simulator without an erase and the next acquisition gets a new resource (#15232)", async () => {
    const journal = new FakeDeviceMutationJournal(harness.timer);
    const mutations = new FakeDeviceMutationResetPort({
      completeKinds: [...DEVICE_MUTATION_KINDS],
      observations: [],
      unobservable: [],
    });
    let erases = 0;
    harness.options.devices.reset = async (resource) => {
      await harness.devices.reset(resource);
      const profile = nativeProfile(resource);
      if (profile.platform !== "ios") {
        throw new Error("Expected iOS");
      }
      const scope = {
        deviceId: "device",
        incarnation: "generation-1",
        sessionUuid: resource.requestId!,
      };
      await journal.captureBaseline(scope, mutations.snapshot);
      const reset = new IosKeepBootedReset({
        journal,
        mutations: Object.assign(mutations, {
          sanitize: async () => {},
          sanitizeCovers: () => false,
          assertSettled: async () => {},
        }),
        timer: harness.timer,
        maxUses: 2,
        fallback: "destroy",
        health: { probe: async () => true },
        simctl: {
          readSimulatorTarget: async () => ({
            udid: scope.deviceId,
            name: "phone",
            state: "Booted",
            isAvailable: true,
            deviceTypeIdentifier: profile.simulatorDeviceTypeIdentifier,
            runtime: profile.runtimeId,
            os_version: profile.osVersion,
          }),
        },
        erase: {
          resetWithTiming: async () => {
            erases++;
            return { outcome: "clean", mode: "erase", phases: { erase: 1, boot: 2 } };
          },
        },
      });
      return reset.resetWithTiming(
        { deviceId: scope.deviceId, platform: "ios", name: "phone" },
        profile,
        async () => {},
        scope,
        resource.reuseCount ?? 0,
      );
    };
    const resourceIds: string[] = [];
    const states: string[] = [];
    for (const use of [1, 2, 3]) {
      const ready = await broker.prepare(exportConfig(`use-${use}`), "token");
      const released = await broker.release(ready.sessionUuid!);
      const request = await harness.store.getRequest(`use-${use}`);
      const resource = await harness.registry
        .sessionBrokerStore(harness.scopeKey)
        .getResource(request!.resourceId!);
      resourceIds.push(request!.resourceId!);
      states.push(resource!.state);
      if (use === 2) {
        expect(released.timing?.reset).toMatchObject({
          mode: "keep-booted",
          outcome: "destroyed",
          fallbackReason: "maxUses reached",
        });
      }
    }
    expect(erases).toBe(0);
    expect(states).toEqual(["idle", "destroyed", "idle"]);
    expect(resourceIds[1]).toBe(resourceIds[0]);
    expect(resourceIds[2]).not.toBe(resourceIds[1]);
  });

  test("reset fallback retains its mode, phases and reason", async () => {
    resetResult = {
      outcome: "fallback:erase",
      mode: "keep-booted",
      phases: { diff: 2, erase: 5 },
      fallbackReason: "baseline diff",
    };
    const ready = await broker.prepare(exportConfig(), "token");
    const released = await broker.release(ready.sessionUuid!);
    expect(released.timing?.reset).toMatchObject({
      outcome: "fallback:erase",
      mode: "keep-booted",
      phases: { diff: 2, erase: 5 },
      fallbackReason: "baseline diff",
    });
    expect((await broker.status(ready.requestId))?.timing).toEqual(released.timing);
  });

  test("pending cleanup records become destroyed on a later recovery status", async () => {
    harness.options.reuseCleanDevices = false;
    harness.devices.canDestroy = false;
    const ready = await broker.prepare(exportConfig(), "token");
    const pending = await broker.release(ready.sessionUuid!);
    expect(pending.outcome).toBe("cleanup_pending");
    expect(pending.timing?.reset?.outcome).toBe("pending");
    harness.devices.canDestroy = true;
    await broker.recover();
    const status = await broker.status(ready.requestId);
    expect(status?.cleanupPending).toBe(false);
    expect(status?.timing?.reset?.outcome).toBe("destroyed");
  });

  test("failed native reset persists partial erase phases and the retirement reason", async () => {
    harness.options.devices = {
      ...harness.options.devices,
      reset: async () => {
        throw new ResetFailureError("erase failed", {
          mode: "erase",
          outcome: "pending",
          phases: { stop: 3, erase: 5 },
          fallbackReason: "erase failed",
        });
      },
    };
    broker = new SessionBroker(harness.options);
    const ready = await broker.prepare(exportConfig(), "token");
    const released = await broker.release(ready.sessionUuid!);
    expect(released.timing?.reset).toMatchObject({
      mode: "erase",
      outcome: "destroyed",
      phases: { stop: 3, erase: 5 },
      fallbackReason: "erase failed",
    });
    expect((await broker.stats()).groups[0].retirements).toBe(1);
  });

  test("timing survives constructing another store and prunes with its terminal receipt", async () => {
    harness.options.reuseCleanDevices = false;
    const ready = await broker.prepare(exportConfig(), "token");
    const released = await broker.release(ready.sessionUuid!);
    const reopened = new SessionBroker({
      ...harness.options,
      store: harness.registry.sessionBrokerStore(harness.scopeKey),
    });
    try {
      expect((await reopened.status(ready.requestId))?.timing).toEqual(released.timing);
      harness.timer.advanceTime(RECEIPT_RETENTION_MS + 1);
      expect(await reopened.pruneReceipts()).toBe(1);
      expect(await reopened.status(ready.requestId)).toBeUndefined();
      expect((await reopened.stats()).groups).toEqual([]);
    } finally {
      await reopened.close();
    }
  });

  test("timing write failures do not prevent clean release or failed preparation receipts", async () => {
    const ready = await broker.prepare(exportConfig(), "token");
    const write = spyOn(harness.store, "recordTiming").mockRejectedValue(
      new Error("timing database unavailable"),
    );
    try {
      expect((await broker.release(ready.sessionUuid!)).outcome).toBe("released");
      harness.options.devices.prepare = async () => {
        throw new Error("preparation failed");
      };
      expect((await broker.prepare(exportConfig("failure"), "token")).outcome).toBe("failed");
    } finally {
      write.mockRestore();
    }
  });

  test("timing write failures do not turn a thrown reset into a thrown release", async () => {
    const ready = await broker.prepare(exportConfig(), "token");
    harness.options.devices.reset = async () => {
      throw new Error("reset failed");
    };
    const write = spyOn(harness.store, "recordTiming").mockRejectedValue(
      new Error("timing unavailable"),
    );
    try {
      expect((await broker.release(ready.sessionUuid!)).outcome).toBe("released");
      expect(
        (
          await harness.store.getResource(
            (await harness.store.getRequest(ready.requestId))!.resourceId!,
          )
        )?.state,
      ).toBe("destroyed");
    } finally {
      write.mockRestore();
    }
  });

  test("unrecognized fallback outcomes never enter the idle pool", async () => {
    const ready = await broker.prepare(exportConfig(), "token");
    harness.options.devices.reset = async () =>
      JSON.parse('{"outcome":"fallback:none","mode":"none","phases":{}}');
    expect((await broker.release(ready.sessionUuid!)).timing?.reset?.outcome).toBe("destroyed");
  });

  test("cleanup finalizes timing without an unfenced post-destruction request read", async () => {
    harness.options.reuseCleanDevices = false;
    harness.devices.canDestroy = false;
    const ready = await broker.prepare(exportConfig(), "token");
    await broker.release(ready.sessionUuid!);
    const request = (await harness.store.getRequest(ready.requestId))!;
    const resource = (await harness.store.getResource(request.resourceId!))!;
    harness.devices.canDestroy = true;
    const read = spyOn(harness.store, "getRequest").mockRejectedValue(
      new Error("post-cleanup read failed"),
    );
    try {
      await harness.devices.destroy(resource);
      expect(
        await harness.store.confirmDestroyed({
          resourceId: resource.resourceId,
          revision: resource.revision,
        }),
      ).toBe(true);
    } finally {
      read.mockRestore();
    }
    expect((await broker.status(ready.requestId))?.timing?.reset?.outcome).toBe("destroyed");
  });

  test("a post-commit read failure does not downgrade a clean reset", async () => {
    const ready = await broker.prepare(exportConfig(), "token");
    const getResource = harness.store.getResource.bind(harness.store);
    let failNextRead = false;
    const read = spyOn(harness.store, "getResource").mockImplementation(async (resourceId) => {
      if (failNextRead) {
        failNextRead = false;
        throw new Error("post-commit resource read failed");
      }
      return getResource(resourceId);
    });
    harness.options.devices.reset = async () => {
      failNextRead = true;
      return resetResult;
    };
    try {
      await broker.release(ready.sessionUuid!);
      expect((await broker.status(ready.requestId))?.timing?.reset?.outcome).toBe("clean");
      expect((await broker.status(ready.requestId))?.timing?.reset?.fallbackReason).toBeUndefined();
    } finally {
      read.mockRestore();
    }
  });

  test("release retries start a fresh reset attempt without old phases or reasons", async () => {
    const ready = await broker.prepare(exportConfig(), "token");
    const request = (await harness.store.getRequest(ready.requestId))!;
    const resource = (await harness.store.getResource(request.resourceId!))!;
    request.timing!.reset = {
      mode: "erase",
      outcome: "pending",
      startedAtMs: 0,
      totalMs: 10,
      reuseCount: 0,
      phases: { erase: 10 },
      fallbackReason: "old failure",
    };
    const recorder = new BrokerTimingRecorder(harness.store, harness.timer);
    expect(recorder.initialResetTiming(request, resource)).toEqual({
      mode: "none",
      outcome: "pending",
      startedAtMs: harness.timer.now(),
      totalMs: 0,
      reuseCount: 0,
      phases: {},
    });
  });

  test("idle trimming counts a retirement while destruction is still pending", async () => {
    harness.options.limits.idlePoolCap = 0;
    harness.devices.canDestroy = false;
    const ready = await broker.prepare(exportConfig(), "token");
    const released = await broker.release(ready.sessionUuid!);
    expect(released.timing?.reset).toMatchObject({ outcome: "pending", retired: true });
    expect((await broker.stats()).groups[0].retirements).toBe(1);
    harness.devices.canDestroy = true;
    await broker.recover();
    expect((await broker.status(ready.requestId))?.timing?.reset?.outcome).toBe("destroyed");
  });

  test("failed acquisitions do not contribute latency or dilute the reuse hit rate", async () => {
    const ready = await broker.prepare(exportConfig(), "token");
    const request = (await harness.store.getRequest(ready.requestId))!;
    const resource = (await harness.store.getResource(request.resourceId!))!;
    const groups = aggregateBrokerTimings(
      [
        {
          profile: nativeProfile(resource),
          timing: {
            acquisition: {
              ...request.timing!.acquisition!,
              outcome: "ready",
              admission: "reuse",
              totalMs: 2,
            },
          },
        },
        {
          profile: nativeProfile(resource),
          timing: {
            acquisition: { ...request.timing!.acquisition!, outcome: "failed", totalMs: 1000 },
          },
        },
      ],
      0,
      harness.timer.now(),
    );
    expect(groups[0]).toMatchObject({
      acquisitions: 1,
      reuseHitRate: 1,
      acquisitionPhases: { totalMs: { count: 1, p50: 2, p90: 2 } },
    });
  });

  test("evict-then-create timing attributes failures to the selected creation profile", async () => {
    const ready = await broker.prepare(exportConfig(), "token");
    const request = (await harness.store.getRequest(ready.requestId))!;
    const resource = (await harness.store.getResource(request.resourceId!))!;
    const target = { profile: { ...nativeProfile(resource), runtimeId: "new-runtime" } };
    const fields = pendingAcquisitionTiming(
      {
        ...harness.options,
        requestId: "next",
        fingerprint: "next",
        parameters: {},
        timingStartedAtMs: harness.timer.now(),
        resolveCreation: () => target,
        matches: () => false,
      },
      { ...request, timing: undefined },
      { ...resource, reuseCount: 7 },
      "evict",
      harness.timer.now(),
      target,
    );
    expect(JSON.parse(fields.timing_profile_json!)).toMatchObject({ runtimeId: "new-runtime" });
    expect(JSON.parse(fields.timing_json!).acquisition.reuseCount).toBe(0);
  });

  test("reuse after eviction updates the pending admission timing", async () => {
    const ready = await broker.prepare(exportConfig(), "timing-source");
    const request = (await harness.store.getRequest(ready.requestId))!;
    const resource = (await harness.store.getResource(request.resourceId!))!;
    const fields = pendingAcquisitionTiming(
      {
        ...harness.options,
        requestId: "next",
        fingerprint: "next",
        parameters: {},
        timingStartedAtMs: 10,
        resolveCreation: () => resource.profile,
        matches: () => true,
      },
      {
        ...request,
        timing: {
          acquisition: {
            ...request.timing!.acquisition!,
            admission: "evict-then-create",
            outcome: "pending",
            startedAtMs: 10,
          },
        },
      },
      { ...resource, reuseCount: 8 },
      "reuse",
      30,
    );
    expect(JSON.parse(fields.timing_json!).acquisition).toMatchObject({
      admission: "reuse",
      outcome: "pending",
      reuseCount: 8,
      admissionWaitMs: 20,
      createMs: 0,
      bootMs: 0,
    });
  });

  test("wait timing changes to the admission that continues after the reset", async () => {
    const ready = await broker.prepare(exportConfig(), "wait-timing-source");
    const request = (await harness.store.getRequest(ready.requestId))!;
    const resource = (await harness.store.getResource(request.resourceId!))!;
    const fields = pendingAcquisitionTiming(
      {
        ...harness.options,
        requestId: "waited-request",
        fingerprint: "waited-request",
        parameters: {},
        timingStartedAtMs: 10,
        resolveCreation: () => resource.profile,
        matches: () => true,
      },
      {
        ...request,
        timing: {
          acquisition: {
            ...request.timing!.acquisition!,
            admission: "wait",
            outcome: "pending",
            startedAtMs: 10,
          },
        },
      },
      resource,
      "create",
      30,
    );
    expect(JSON.parse(fields.timing_json!).acquisition).toMatchObject({
      admission: "create",
      outcome: "pending",
      admissionWaitMs: 20,
    });
  });

  test("failed wait timing is terminal rather than left pending", async () => {
    const ready = await broker.prepare(exportConfig(), "failed-wait-source");
    const request = (await harness.store.getRequest(ready.requestId))!;
    const recorder = new BrokerTimingRecorder(harness.store, harness.timer);
    const write = spyOn(harness.store, "recordTiming");
    try {
      await recorder.recordFailedAcquisition({
        ...request,
        timing: {
          acquisition: {
            ...request.timing!.acquisition!,
            admission: "wait",
            outcome: "pending",
          },
        },
      });
      expect(write).toHaveBeenCalledWith(
        request.requestId,
        expect.objectContaining({
          acquisition: expect.objectContaining({ admission: "wait", outcome: "failed" }),
        }),
      );
    } finally {
      write.mockRestore();
    }
  });

  test("corrupt timing JSON and invalid schema are ignored", () => {
    expect(parseTimingReceipt("{")).toBeUndefined();
    expect(parseTimingReceipt('{"acquisition":{"outcome":"ready"}}')).toBeUndefined();
    expect(parseTimingReceipt("{}", '{"platform":"ios"}')).toBeUndefined();
  });

  test("stale failure timing cannot replace an activated acquisition", async () => {
    const ready = await broker.prepare(exportConfig(), "token");
    const request = (await harness.store.getRequest(ready.requestId))!;
    const recorder = new BrokerTimingRecorder(harness.store, harness.timer);
    await recorder.recordFailedAcquisition({
      ...request,
      timing: { acquisition: { ...request.timing!.acquisition!, outcome: "pending" } },
    });
    expect((await broker.status(ready.requestId))?.timing?.acquisition?.outcome).toBe("ready");
  });

  test("recovery never writes failure timing for a retained peer acquisition", async () => {
    const ready = await broker.prepare(exportConfig(), "token");
    const request = (await harness.store.getRequest(ready.requestId))!;
    const snapshot = spyOn(harness.store, "listRecoverableRequests").mockResolvedValue([
      {
        ...request,
        state: "acquiring",
        timing: {
          acquisition: {
            ...request.timing!.acquisition!,
            outcome: "pending",
          },
        },
      },
    ]);
    const takeover = spyOn(harness.store, "recoverRequest").mockResolvedValue(undefined);
    const write = spyOn(harness.store, "recordTiming");
    const peer = new SessionBroker({
      ...harness.options,
      owner: { ...harness.options.owner, pid: harness.options.owner.pid + 1 },
    });
    try {
      await peer.recover();
      expect(takeover).toHaveBeenCalled();
      expect(write).toHaveBeenCalled();
      expect((await broker.status(ready.requestId))?.timing?.acquisition?.outcome).toBe("ready");
    } finally {
      snapshot.mockRestore();
      takeover.mockRestore();
      write.mockRestore();
      await peer.close();
    }
  });

  test("stats reads seeded phases, rates and enforces window and row bounds", async () => {
    const first = await broker.prepare(exportConfig("one"), "token");
    await broker.release(first.sessionUuid!);
    resetResult = {
      outcome: "fallback:erase",
      mode: "snapshot",
      phases: { erase: 9 },
      fallbackReason: "snapshot unavailable",
    };
    const second = await broker.prepare(exportConfig("two"), "token");
    await broker.release(second.sessionUuid!);
    const stats = await broker.stats();
    expect(stats.groups).toHaveLength(1);
    expect(stats.groups[0]).toMatchObject({
      acquisitions: 2,
      resets: 2,
      reuseHitRate: 0.5,
      fallbackRate: 0.5,
      retirements: 0,
      acquisitionPhases: { createMs: { count: 2, p50: 5.5, p90: 9.9 } },
      resetPhases: { erase: { count: 2, p50: 7, p90: 8.6 } },
    });
    expect((await broker.stats(undefined, 1)).truncated).toBe(true);
    await expect(broker.stats(RECEIPT_RETENTION_MS + 1)).rejects.toThrow();
    harness.timer.advanceTime(10);
    expect((await broker.stats(1)).groups).toEqual([]);
  });
});
