import { z } from "zod/v4";
import { readToolEnvelopePayload } from "../../src/utils/toolEnvelopePayload";
import { FakeEmulatorProcessStopper } from "../fakes/FakeEmulatorProcessStopper";
import { describe, expect, spyOn } from "bun:test";
import {
  getDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { InputDeviceOwnedError } from "../../src/daemon/inputDeviceOwnership";
import { sessionOwnershipLostPayload } from "../../src/daemon/deviceSessionResult";
import { TerminalSessionError } from "../../src/daemon/sessionManager";
import { DaemonState } from "../../src/daemon/daemonState";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { logger } from "../../src/utils/logger";
import { BASE, SIBLING, restartStopHarness } from "../helpers/restartStopHarness";
import { drainUntil, drainMicrotasks, settleByFakeEvents } from "../helpers/fakeTimerStepping";

describe("reserved device stop policy", () => {
  const { test, fixture, cleanups } = restartStopHarness();
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  type Tool = "killDevice" | "deleteDevice";

  async function snapshot(f: Fixture) {
    const hold = f.internals.rehydrationReservations.get(f.holder)!;
    const row = await f.persistence.getSession!(f.holder);
    if (!row) {
      throw new Error("Expected persisted restart holder");
    }
    const device = f.pool.getDevice(f.device.deviceId);
    return {
      hold,
      value: { ...hold },
      row: { ...row },
      timers: f.timer.getPendingTimeouts(),
      device,
      pooled: device ? { ...device } : null,
    };
  }
  async function unchanged(f: Fixture, before: Awaited<ReturnType<typeof snapshot>>) {
    expect(f.internals.rehydrationReservations.get(f.holder)).toBe(before.hold);
    expect(before.hold).toEqual(before.value);
    expect(await f.persistence.getSession!(f.holder)).toEqual(before.row);
    expect(f.timer.getPendingTimeouts()).toEqual(before.timers);
  }
  async function refusal(pending: ReturnType<Fixture["call"]>, tool: Tool, fields: object) {
    if (tool === "killDevice") {
      const error = await pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(InputDeviceOwnedError);
      expect(error).toMatchObject(fields);
      if (!(error instanceof InputDeviceOwnedError)) {
        throw new Error("Expected device ownership refusal");
      }
      expect(error.message).toContain(`reserved for session ${BASE}'s device-restart recovery`);
    } else {
      const result = readToolEnvelopePayload(await pending)?.payload;
      expect(result).toMatchObject({
        success: false,
        failure: { phase: "precondition", ...fields },
      });
      expect(
        z.object({ failure: z.object({ message: z.string() }) }).parse(result).failure.message,
      ).toContain(`reserved for session ${BASE}'s device-restart recovery`);
    }
  }
  async function terminal(f: Fixture) {
    expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
    expect(f.pool.genericAvailability(f.device.deviceId)).not.toBe("reserved");
    expect(await f.persistence.getSession!(BASE)).toMatchObject({
      status: "released",
      release_reason: "device-killed",
    });
    expect(f.sessions.getTerminalReleaseSnapshot(BASE)).toMatchObject({
      terminal: true,
      releaseReason: "device-killed",
    });
    const error = await f.sessions.admitIssuedSessionForAutomation(BASE).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(TerminalSessionError);
    if (!(error instanceof TerminalSessionError)) {
      throw new Error("Expected terminal admission refusal");
    }
    expect(
      sessionOwnershipLostPayload({
        message: error.message,
        sessionUuid: error.sessionUuid,
        reason: error.release.releaseReason,
        release: error.release,
      }),
    ).toMatchObject({ error: { code: "session_ownership_lost", reason: "device-killed" } });
    for (const method of ["daemon/heartbeat", "daemon/sessionInfo"]) {
      expect(
        await handleDaemonRequest(
          { type: "daemon_request", id: "stop-read", method, params: { sessionId: BASE } },
          DaemonState.getInstance(),
        ),
      ).toMatchObject({ success: false, releaseReason: "device-killed" });
    }
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
  }

  test("ios deleteDevice: stopped pooled live session without a restart reservation × sessionless", async () => {
    const f = await fixture("ios", false, false, "owner-conn", false);
    f.manager.setBootedDevices("ios", []);
    expect(f.sessions.getSessionForDevice(f.device.deviceId)).toBe(BASE);
    expect(f.internals.rehydrationReservations.size).toBe(0);
    expect(await f.call("deleteDevice")).toMatchObject({
      structuredContent: { state: "destroyed" },
    });
    expect(f.manager.killed).toEqual([]);
    expect(f.pool.getDevice(f.device.deviceId)).toBeNull();
  });

  // Android runtime serials can be recycled or change; iOS UDIDs are the stable identity.
  for (const pooled of [false, true]) {
    for (const tool of ["killDevice", "deleteDevice"] as const) {
      for (const requester of [undefined, "other-session"]) {
        test(`android ${tool}: recycled serial unrelated AVD, pooled ${pooled} × ${requester ?? "sessionless"}`, async () => {
          const f = await fixture("android");
          await f.pool.removeDevice(
            f.device.deviceId,
            true,
            f.pool.getDevice(f.device.deviceId) ?? undefined,
          );
          const unrelated = { ...f.device, name: "unrelated-phone" };
          f.manager.setBootedDevices("android", [unrelated]);
          f.manager.setDeviceImages("android", [
            { ...f.device, isRunning: true },
            { ...unrelated, isRunning: true },
          ]);
          if (pooled) {
            await f.pool.initializeWithDevices([unrelated]);
          }
          const before = await snapshot(f);
          const result = await f.call(tool, requester, false, undefined, undefined, unrelated);
          if (tool === "deleteDevice") {
            expect(result).toMatchObject({ structuredContent: { state: "destroyed" } });
          }
          expect(f.manager.killed).toEqual([unrelated.deviceId]);
          await unchanged(f, before);
        });
      }
      for (const caller of ["other-session", "sessionless", "owner"] as const) {
        test(`android ${tool}: reserved AVD on another serial, pooled ${pooled} × ${caller}`, async () => {
          const f = await fixture("android");
          await f.pool.removeDevice(
            f.device.deviceId,
            true,
            f.pool.getDevice(f.device.deviceId) ?? undefined,
          );
          const returned = { ...f.device, deviceId: "emulator-5556" };
          f.manager.setBootedDevices("android", [returned]);
          f.manager.setDeviceImages("android", [{ ...returned, isRunning: true }]);
          if (pooled) {
            await f.pool.initializeWithDevices([returned]);
            expect(f.pool.genericAvailability(returned.deviceId)).toBe("reserved");
          }
          f.timer.advanceTime(1_234);
          const before = await snapshot(f);
          const pending = f.call(
            tool,
            caller === "sessionless" ? undefined : caller === "owner" ? BASE : caller,
            false,
            undefined,
            undefined,
            returned,
          );
          if (caller === "other-session") {
            await refusal(pending, tool, {
              code: "device_owned_by_other_session",
              retryable: true,
              retryAfterMs: before.hold.scheduledDeadlineMs! - f.sessions.sessionNow(),
            });
            await unchanged(f, before);
            expect(f.manager.killed).toEqual([]);
            expect(
              f.manager.getExecutedOperations().filter((op) => op.startsWith("destroyDevice")),
            ).toEqual([]);
          } else {
            const result = await pending;
            if (tool === "deleteDevice") {
              expect(result).toMatchObject({ structuredContent: { state: "destroyed" } });
            }
            expect(f.manager.killed).toEqual([returned.deviceId]);
            expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
            if (caller === "sessionless") {
              await terminal(f);
            } else {
              expect(await f.persistence.getSession!(BASE)).toEqual(before.row);
              expect(before.row.release_reason).toStartWith("device-restart:");
            }
          }
        });
      }
    }
    for (const requester of [undefined, "other-session", BASE]) {
      test(`android killDevice: forced unknown identity, pooled ${pooled} × ${requester ?? "sessionless"}`, async () => {
        const f = await fixture("android");
        await f.pool.removeDevice(
          f.device.deviceId,
          true,
          f.pool.getDevice(f.device.deviceId) ?? undefined,
        );
        const unknown = { ...f.device, name: `Unknown (${f.device.deviceId})` };
        f.manager.setBootedDevices("android", [unknown]);
        if (pooled) {
          await f.pool.initializeWithDevices([unknown]);
        }
        const before = await snapshot(f);
        const pending = f.call("killDevice", requester, true, undefined, undefined, unknown);
        if (requester === BASE) {
          await pending;
          expect(f.manager.killed).toEqual([unknown.deviceId]);
          expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
          expect(await f.persistence.getSession!(BASE)).toEqual(before.row);
        } else {
          await expect(pending).rejects.toMatchObject({
            code: "discovery_incomplete",
            retryable: true,
          });
          expect(f.manager.killed).toEqual([]);
          await unchanged(f, before);
        }
      });
    }
    for (const tool of ["killDevice", "deleteDevice"] as const) {
      for (const caller of ["other-session", "sessionless", "owner"] as const) {
        test(`ios ${tool}: reserved UDID, pooled ${pooled} × ${caller}`, async () => {
          const f = await fixture("ios");
          if (!pooled) {
            await f.pool.removeDevice(
              f.device.deviceId,
              true,
              f.pool.getDevice(f.device.deviceId) ?? undefined,
            );
          }
          f.timer.advanceTime(1_234);
          const before = await snapshot(f);
          const pending = f.call(
            tool,
            caller === "sessionless" ? undefined : caller === "owner" ? BASE : caller,
          );
          if (caller === "other-session") {
            await refusal(pending, tool, {
              code: "device_owned_by_other_session",
              retryable: true,
              retryAfterMs: before.hold.scheduledDeadlineMs! - f.sessions.sessionNow(),
            });
            await unchanged(f, before);
            expect(f.manager.killed).toEqual([]);
            expect(
              f.manager.getExecutedOperations().filter((op) => op.startsWith("destroyDevice")),
            ).toEqual([]);
          } else {
            const result = await pending;
            if (tool === "deleteDevice") {
              expect(result).toMatchObject({ structuredContent: { state: "destroyed" } });
            }
            expect(f.manager.killed).toEqual([f.device.deviceId]);
            if (caller === "sessionless") {
              await terminal(f);
            } else {
              expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
              expect(await f.persistence.getSession!(BASE)).toEqual(before.row);
            }
          }
        });
      }
    }
  }

  // These two timelines are Android-only: iOS UDID is both serial and daemon-known stable id.
  async function unknownTarget(f: Fixture, deviceId: string, pooled: boolean, runtimeName: string) {
    await f.pool.removeDevice(
      f.device.deviceId,
      true,
      f.pool.getDevice(f.device.deviceId) ?? undefined,
    );
    const target = { ...f.device, deviceId, name: `Unknown (${deviceId})` };
    f.manager.setBootedDevices("android", [target]);
    if (pooled) {
      await f.pool.initializeWithDevices([target]);
    }
    setDeviceToolsDependencies({ resolveRunningAndroidAvdName: async () => runtimeName });
    const probe = spyOn(getDeviceToolsDependencies(), "resolveRunningAndroidAvdName");
    cleanups.push(() => probe.mockRestore());
    return { target, probe };
  }

  for (const pooled of [false, true]) {
    for (const force of [false, true]) {
      for (const requester of [undefined, "other-session"]) {
        test(`identity A killDevice: stale caller label, pooled ${pooled}, force ${force}, ${requester ?? "sessionless"}`, async () => {
          const f = await fixture("android");
          const { target, probe } = await unknownTarget(
            f,
            f.device.deviceId,
            pooled,
            "unrelated-phone",
          );
          f.manager.setBootedDevices("android", [{ ...target, name: "unrelated-phone" }]);
          f.manager.compareAvdName = true;
          const before = await snapshot(f);
          const pending = f.call("killDevice", requester, force, undefined, undefined, f.device);
          if (force) {
            await pending;
            expect(f.manager.killed).toEqual([target.deviceId]);
            expect(f.manager.killedTargets[0]!.name).toBe("unrelated-phone");
          } else {
            await expect(pending).rejects.toThrow("AVD name differs from discovered runtime");
            expect(f.manager.killed).toEqual([]);
          }
          expect(probe).toHaveBeenCalledTimes(1);
          await unchanged(f, before);
        });
        test(`identity A deleteDevice: stale target label, pooled ${pooled}, force ${force}, ${requester ?? "sessionless"}`, async () => {
          const f = await fixture("android");
          const { probe } = await unknownTarget(f, f.device.deviceId, pooled, "unrelated-phone");
          // Stale discovery names R, so teardown can select the recycled serial; the console disagrees.
          f.manager.setBootedDevices("android", [f.device]);
          f.manager.compareAvdName = true;
          f.manager.confirmedRuntimeAvdName = "unrelated-phone";
          const before = await snapshot(f);
          const response = await f.call("deleteDevice", requester, force);
          if (force) {
            expect(response).toMatchObject({ structuredContent: { state: "destroyed" } });
            expect(f.manager.killed).toEqual([f.device.deviceId]);
            expect(f.manager.killedTargets[0]!.name).toBe("unrelated-phone");
          } else {
            expect(readToolEnvelopePayload(response)?.payload).toMatchObject({
              success: false,
              failure: {
                phase: "stop",
                code: "operation_failed",
                message:
                  "Failed to kill android device: Error: AVD name differs from discovered runtime",
              },
            });
            expect(f.manager.killed).toEqual([]);
          }
          expect(probe).toHaveBeenCalledTimes(1);
          await unchanged(f, before);
        });
      }
      for (const tool of ["killDevice", "deleteDevice"] as const) {
        for (const caller of ["other-session", "sessionless", "owner", "connection"] as const) {
          test(`identity B ${tool}: confirmed reserved AVD on unknown new serial, pooled ${pooled}, force ${force}, ${caller}`, async () => {
            const f = await fixture("android");
            const { target: returned, probe } = await unknownTarget(
              f,
              "emulator-5556",
              pooled,
              f.device.name,
            );
            // deleteDevice resolves the image from discovery; the pool still has an unknown label.
            f.manager.setBootedDevices("android", [
              tool === "killDevice" ? returned : { ...returned, name: f.device.name },
            ]);
            f.manager.confirmedRuntimeAvdName = f.device.name;
            f.manager.setDeviceImages("android", [{ ...f.device, isRunning: true }]);
            f.manager.compareAvdName = true;
            f.timer.advanceTime(1_234);
            const before = await snapshot(f);
            const pending = f.call(
              tool,
              caller === "other-session" ? caller : caller === "owner" ? BASE : undefined,
              force,
              caller === "connection" ? "owner-conn" : undefined,
              undefined,
              tool === "killDevice" ? returned : { ...returned, name: f.device.name },
            );
            if (caller === "other-session") {
              await refusal(pending, tool, {
                code: "device_owned_by_other_session",
                retryable: true,
                retryAfterMs: before.hold.scheduledDeadlineMs! - f.sessions.sessionNow(),
              });
              expect(f.manager.killed).toEqual([]);
              await unchanged(f, before);
            } else {
              await pending;
              expect(f.manager.killed).toEqual([returned.deviceId]);
              expect(f.manager.killedTargets[0]!.name).toBe(f.device.name);
              expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
              if (caller === "sessionless") {
                await terminal(f);
              } else {
                expect(await f.persistence.getSession!(BASE)).toEqual(before.row);
              }
            }
            expect(probe).toHaveBeenCalledTimes(1);
          });
        }
      }
    }
  }
  for (const force of [false, true]) {
    for (const requester of [undefined, "other-session"]) {
      for (const mode of ["unresolved", "throws"] as const) {
        for (const tool of ["killDevice", "deleteDevice"] as const) {
          test(`identity unconfirmed ${tool}: ${mode}, force ${force}, ${requester ?? "sessionless"}`, async () => {
            const f = await fixture("android");
            await unknownTarget(f, f.device.deviceId, true, "restart-phone");
            f.manager.setBootedDevices("android", [f.device]);
            setDeviceToolsDependencies({
              resolveRunningAndroidAvdName: async () => {
                if (mode === "throws") {
                  throw new Error("console transport transitional");
                }
                return undefined;
              },
            });
            const before = await snapshot(f);
            const pending = f.call(tool, requester, force);
            if (tool === "killDevice") {
              await expect(pending).rejects.toMatchObject({
                code: "discovery_incomplete",
                retryable: true,
              });
            } else {
              expect(readToolEnvelopePayload(await pending)?.payload).toMatchObject({
                success: false,
                failure: { phase: "precondition", code: "discovery_incomplete", retryable: true },
              });
            }
            expect(f.manager.killed).toEqual([]);
            await unchanged(f, before);
          });
        }
      }
    }
    test(`identity unconfirmed killDevice: no reservation skips probe, force ${force}`, async () => {
      const f = await fixture("android");
      f.pool.testHooks.releaseDeviceRestartReservation(BASE);
      await f.pool.removeDevice(
        f.device.deviceId,
        true,
        f.pool.getDevice(f.device.deviceId) ?? undefined,
      );
      const target = { ...f.device, name: `Unknown (${f.device.deviceId})` };
      f.manager.setBootedDevices("android", [target]);
      const probe = spyOn(
        getDeviceToolsDependencies(),
        "resolveRunningAndroidAvdName",
      ).mockResolvedValue(undefined);
      cleanups.push(() => probe.mockRestore());
      await f.call("killDevice", undefined, force, undefined, undefined, target);
      expect(f.manager.killed).toEqual([target.deviceId]);
      expect(probe).not.toHaveBeenCalled();
    });
  }
  for (const force of [false, true]) {
    for (const requester of [undefined, "other-session"]) {
      for (const tool of ["killDevice", "deleteDevice"] as const) {
        test(`identity unconfirmed ${tool}: new serial matches only caller hint, force ${force}, ${requester ?? "sessionless"}`, async () => {
          const f = await fixture("android");
          const { target } = await unknownTarget(f, "emulator-5556", true, "restart-phone");
          const stale = { ...target, name: f.device.name };
          f.manager.setBootedDevices("android", [stale]);
          setDeviceToolsDependencies({ resolveRunningAndroidAvdName: async () => undefined });
          const before = await snapshot(f);
          const pending = f.call(tool, requester, force, undefined, undefined, stale);
          if (tool === "killDevice") {
            await expect(pending).rejects.toMatchObject({
              code: "discovery_incomplete",
              retryable: true,
            });
          } else {
            expect(readToolEnvelopePayload(await pending)?.payload).toMatchObject({
              success: false,
              failure: { phase: "precondition", code: "discovery_incomplete", retryable: true },
            });
          }
          expect(f.manager.killed).toEqual([]);
          expect(f.internals.intentionalShutdowns.size).toBe(0);
          await unchanged(f, before);
        });
      }
    }
    test(`identity unconfirmed killDevice: reservation cannot be this target, force ${force}`, async () => {
      const f = await fixture("android");
      const { target } = await unknownTarget(f, "emulator-5556", true, "restart-phone");
      setDeviceToolsDependencies({ resolveRunningAndroidAvdName: async () => undefined });
      const before = await snapshot(f);
      await f.call("killDevice", "other-session", force, undefined, undefined, target);
      expect(f.manager.killed).toEqual([target.deviceId]);
      await unchanged(f, before);
    });
  }

  for (const tool of ["killDevice", "deleteDevice"] as const) {
    test(`identity ${tool}: resolved pooled AVD needs no extra probe`, async () => {
      const f = await fixture("android");
      const probe = spyOn(
        getDeviceToolsDependencies(),
        "resolveRunningAndroidAvdName",
      ).mockResolvedValue(undefined);
      cleanups.push(() => probe.mockRestore());
      await f.call(tool);
      await terminal(f);
      expect(probe).not.toHaveBeenCalled();
    });
  }
  for (const tool of ["killDevice", "deleteDevice"] as const) {
    for (const mode of ["unresolved", "throws"] as const) {
      test(`identity ${tool}: existing kill-time probe ${mode} before mutation`, async () => {
        const f = await fixture("android");
        const unknown = { ...f.device, name: `Unknown (${f.device.deviceId})` };
        f.pool.getDevice(f.device.deviceId)!.avdName = f.device.name;
        f.manager.setBootedDevices("android", [unknown]);
        setDeviceToolsDependencies({
          androidEmulatorProcessStopper: new FakeEmulatorProcessStopper(),
          resolveRunningAndroidAvdName: async () => {
            if (mode === "throws") {
              throw new Error("console transport transitional");
            }
            return undefined;
          },
        });
        const before = await snapshot(f);
        const pending = f.call(
          tool,
          undefined,
          false,
          undefined,
          undefined,
          tool === "killDevice" ? unknown : f.device,
        );
        if (tool === "killDevice") {
          await expect(pending).rejects.toMatchObject({
            code: "discovery_incomplete",
            retryable: true,
          });
        } else {
          expect(readToolEnvelopePayload(await pending)?.payload).toMatchObject({
            success: false,
            failure: { code: "discovery_incomplete", retryable: true },
          });
        }
        expect(f.manager.killed).toEqual([]);
        expect(f.internals.intentionalShutdowns.size).toBe(0);
        await unchanged(f, before);
      });
    }
  }

  for (const force of [false, true]) {
    for (const owner of ["routing", "connection"] as const) {
      test(`identity unconfirmed killDevice: own hold exception by ${owner}, force ${force}`, async () => {
        const f = await fixture("android");
        const { target } = await unknownTarget(f, f.device.deviceId, true, "restart-phone");
        setDeviceToolsDependencies({ resolveRunningAndroidAvdName: async () => undefined });
        const before = await snapshot(f);
        await f.call(
          "killDevice",
          owner === "routing" ? BASE : undefined,
          force,
          owner === "connection" ? "owner-conn" : undefined,
          undefined,
          target,
        );
        expect(f.manager.killed).toEqual([target.deviceId]);
        expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
        expect(await f.persistence.getSession!(BASE)).toEqual(before.row);
      });
    }
  }

  test("token-proved reconnect is the stop owner without a routing session for both tools", async () => {
    for (const tool of ["killDevice", "deleteDevice"] as const) {
      const f = await fixture("android", false, false, "owner-conn", true, "holder-token");
      const before = await snapshot(f);
      expect(
        await f.pool.restoreOwnedDeviceSessionsForMcpSession([BASE], "reconnected", "holder-token"),
      ).toEqual([]);
      expect(
        f.internals.rehydrationReservations.get(BASE)!.ownerMcpSessionIds?.has("reconnected"),
      ).toBe(true);
      await f.call(tool, undefined, false, "reconnected");
      expect(f.manager.killed).toEqual([f.device.deviceId]);
      expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
      expect(await f.persistence.getSession!(BASE)).toEqual(before.row);
    }
  });

  for (const platform of ["android", "ios"] as const) {
    for (const tool of ["killDevice", "deleteDevice"] as const) {
      for (const force of [false, true]) {
        test(`${platform} ${tool}: reserved for other × different session, force ${force}`, async () => {
          const f = await fixture(platform);
          f.timer.advanceTime(1_234);
          const before = await snapshot(f);
          const reserve = spyOn(f.pool, "reserveDeviceForShutdown");
          cleanups.push(() => reserve.mockRestore());
          await refusal(f.call(tool, "other-session", force), tool, {
            code: "device_owned_by_other_session",
            retryable: true,
            retryAfterMs: before.hold.scheduledDeadlineMs! - f.sessions.sessionNow(),
          });
          await unchanged(f, before);
          expect(f.manager.killed).toEqual([]);
          expect(
            f.manager.getExecutedOperations().filter((op) => op.startsWith("destroyDevice")),
          ).toEqual([]);
          expect(f.pool.getDevice(f.device.deviceId)).toBe(before.device);
          expect(before.device).toEqual(before.pooled);
          expect(reserve).not.toHaveBeenCalled();
          expect(f.internals.intentionalShutdowns.size).toBe(0);
        });
        for (const connection of [undefined, "rival-conn"]) {
          test(`${platform} ${tool}: reserved for other × sessionless ${connection ?? "CLI"}, force ${force}`, async () => {
            const f = await fixture(platform);
            await f.pool.reserveDevicesForRehydration([
              {
                sessionId: BASE,
                target: {
                  platform,
                  stableDeviceId: platform === "android" ? f.device.name : f.device.deviceId,
                  deviceId: f.device.deviceId,
                },
              },
            ]);
            const result = await f.call(tool, undefined, force, connection);
            if (tool === "deleteDevice") {
              expect(result).toMatchObject({ structuredContent: { state: "destroyed" } });
            }
            expect(f.manager.killed).toEqual([f.device.deviceId]);
            await terminal(f);
          });
        }
        test(`${platform} ${tool}: reserved for other × connection holds another live session, force ${force}`, async () => {
          const f = await fixture(platform);
          const other = {
            ...f.device,
            name: "spare",
            deviceId: platform === "android" ? "emulator-5556" : "spare-sim",
          };
          f.manager.setBootedDevices(platform, [f.device, other]);
          await f.pool.initializeWithDevices([f.device, other]);
          await f.pool.bindOrReuseDeviceSession({
            sessionId: "other-session",
            deviceId: other.deviceId,
            platform,
            expectedIdentity: other,
            allowSessionRebind: false,
            mcpSessionId: "rival-conn",
          });
          const before = await snapshot(f);
          await refusal(f.call(tool, undefined, force, "rival-conn"), tool, {
            code: "device_owned_by_other_session",
            retryable: true,
            retryAfterMs: before.hold.scheduledDeadlineMs! - f.sessions.sessionNow(),
          });
          await unchanged(f, before);
          expect(f.manager.killed).toEqual([]);
        });
      }
      test(`${platform} ${tool}: another reservation is rechecked under the shutdown lock`, async () => {
        const f = await fixture(platform);
        const hold = f.internals.rehydrationReservations.get(BASE)!;
        // The owner passed entry admission; another hold replaces it before the lock recheck.
        const original = f.pool.reserveDeviceForShutdown.bind(f.pool);
        const reserve = spyOn(f.pool, "reserveDeviceForShutdown").mockImplementation(
          async (...args) => {
            f.internals.rehydrationReservations.delete(BASE);
            f.internals.rehydrationReservations.set("other-holder", hold);
            return await original(...args);
          },
        );
        cleanups.push(() => reserve.mockRestore());
        const pending = f.call(tool, BASE, true);
        if (tool === "killDevice") {
          await expect(pending).rejects.toMatchObject({
            code: "device_owned_by_other_session",
            retryable: true,
          });
        } else {
          expect(readToolEnvelopePayload(await pending)?.payload).toMatchObject({
            failure: { phase: "stop", code: "device_owned_by_other_session", retryable: true },
          });
        }
        expect(f.manager.killed).toEqual([]);
        expect(f.internals.rehydrationReservations.get("other-holder")).toBe(hold);
        expect(f.internals.intentionalShutdowns.size).toBe(0);
        expect(f.internals.isReservedForShutdown(f.pool.getDevice(f.device.deviceId)!)).toBe(false);
      });
      test(`${platform} ${tool}: sessionless stop awaits the journaled conditional terminal write`, async () => {
        const f = await fixture(platform);
        const gate = Promise.withResolvers<void>();
        const mark = f.persistence.markReleased.bind(f.persistence);
        let attempted = false;
        let completed = false;
        const write = spyOn(f.persistence, "markReleased").mockImplementation(async (...args) => {
          if (args[3] === "device-killed") {
            attempted = true;
            expect(f.journal.loadUnconfirmed()).toMatchObject([
              { sessionId: BASE, reason: "device-killed" },
            ]);
            expect(args[4]).toMatchObject({
              expectedRowGeneration: 0,
              onlyIfOwnedByDaemon: "stop-hold-daemon",
              onlyIfRecoverable: true,
            });
            await gate.promise;
          }
          await mark(...args);
        });
        cleanups.push(() => write.mockRestore());
        const pending = f.call(tool).finally(() => {
          completed = true;
        });
        try {
          await drainUntil(() => attempted, { description: "conditional terminal write" });
          expect(completed).toBe(false);
          expect(f.sessions.getTerminalReleaseSnapshot(BASE)).toBeUndefined();
          expect((await f.persistence.getSession!(BASE))?.release_reason).toStartWith(
            "device-restart:",
          );
        } finally {
          gate.resolve();
        }
        await pending;
        await terminal(f);
        expect(f.journal.loadUnconfirmed()).toEqual([]);
      });
      test(`${platform} ${tool}: daemon-rehydration-only reservation keeps today's behavior`, async () => {
        const f = await fixture(platform);
        f.pool.testHooks.releaseDeviceRestartReservation(BASE);
        await f.pool.reserveDevicesForRehydration([
          {
            sessionId: BASE,
            target: {
              platform,
              stableDeviceId: platform === "android" ? f.device.name : f.device.deviceId,
              deviceId: f.device.deviceId,
            },
          },
        ]);
        const before = await snapshot(f);
        await f.call(tool, "other-session", true);
        expect(f.manager.killed).toEqual([f.device.deviceId]);
        expect(f.internals.rehydrationReservations.get(BASE)).toBe(before.hold);
        expect(await f.persistence.getSession!(BASE)).toEqual(before.row);
      });
      for (const owner of ["routing", "label", "connection"] as const) {
        test(`${platform} ${tool}: reserved for me × owner by ${owner}`, async () => {
          const f = await fixture(platform, owner === "label");
          await f.call(
            tool,
            owner === "connection" ? undefined : owner === "label" ? SIBLING : BASE,
            false,
            "owner-conn",
          );
          expect(f.manager.killed).toEqual([f.device.deviceId]);
          expect(f.internals.rehydrationReservations.has(f.holder)).toBe(false);
          expect(await f.persistence.getSession!(f.holder)).toMatchObject({
            release_reason: `device-restart:${platform === "android" ? f.device.name : f.device.deviceId}`,
          });
          expect(f.sessions.getTerminalReleaseSnapshot(f.holder)).toBeUndefined();
        });
      }
      for (const mode of ["throws", "cancelled", "unconfirmed", "command timeout"] as const) {
        test(`${platform} ${tool}: reserved for other × sessionless ${mode} changes nothing`, async () => {
          const f = await fixture(platform);
          const before = await snapshot(f);
          const gate = Promise.withResolvers<void>();
          const abort = new AbortController();
          f.manager.stayRunning = mode === "unconfirmed";
          f.manager.beforeKill = async () => {
            if (mode === "throws") {
              throw new Error("platform stop failed");
            }
            if (mode === "cancelled") {
              abort.abort();
            }
            if (mode === "cancelled" || mode === "command timeout") {
              await gate.promise;
            }
          };
          const pending = f.call(tool, undefined, false, undefined, abort.signal).then(
            (result) => result,
            (error: unknown) => error,
          );
          await drainUntil(() => f.manager.killed.length === 1, { description: "platform kill" });
          const result = await settleByFakeEvents(f.timer, pending, { description: mode });
          try {
            if (tool === "killDevice") {
              expect(result).toBeInstanceOf(Error);
            } else {
              expect(readToolEnvelopePayload(result)?.payload).toMatchObject({ success: false });
            }
            expect(f.internals.rehydrationReservations.get(BASE)).toBe(before.hold);
            expect(before.hold).toEqual(before.value);
            expect(await f.persistence.getSession!(BASE)).toEqual(before.row);
            expect(f.timer.getPendingTimeouts()).toContain(before.timers[0]);
          } finally {
            gate.resolve();
            await drainMicrotasks(156);
          }
          expect(f.internals.rehydrationReservations.get(BASE)).toBe(before.hold);
        });
      }
      for (const rowState of ["peer", "changed", "live", "failure"] as const) {
        test(`${platform} ${tool}: sessionless terminal write ${rowState} leaves the row and stop succeeds`, async () => {
          const f = await fixture(platform);
          const warn = spyOn(logger, "warn").mockImplementation(() => {});
          cleanups.push(() => warn.mockRestore());
          let saved: Awaited<ReturnType<typeof f.persistence.getSession>>;
          f.manager.beforeKill = async () => {
            const row = (await f.persistence.getSession!(BASE))!;
            if (rowState === "peer") {
              row.daemon_session_id = "live-peer";
            }
            if (rowState === "live") {
              row.status = "active";
              row.release_reason = null;
            }
            if (rowState === "failure") {
              f.persistence.failure = "release";
            }
            saved = { ...row };
          };
          if (rowState === "changed") {
            const mark = f.persistence.markReleased.bind(f.persistence);
            const write = spyOn(f.persistence, "markReleased").mockImplementation(
              async (...args) => {
                if (args[3] === "device-killed") {
                  const row = (await f.persistence.getSession!(BASE))!;
                  row.stable_identity_generation!++;
                  saved = { ...row };
                }
                await mark(...args);
              },
            );
            cleanups.push(() => write.mockRestore());
          }
          await f.call(tool);
          expect(f.manager.killed).toEqual([f.device.deviceId]);
          expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
          expect(await f.persistence.getSession!(BASE)).toEqual(saved);
          expect(f.sessions.getTerminalReleaseSnapshot(BASE)).toBeUndefined();
          expect(warn).toHaveBeenCalled();
        });
      }
      test(`${platform} ${tool}: new hold for R survives old sessionless stop`, async () => {
        const f = await fixture(platform);
        const old = f.internals.rehydrationReservations.get(BASE)!;
        const replacement = { ...old };
        f.manager.beforeKill = () => {
          f.internals.rehydrationReservations.set(BASE, replacement);
        };
        const persisted = await f.persistence.getSession!(BASE);
        if (!persisted) {
          throw new Error("Expected persisted restart holder");
        }
        const row = { ...persisted };
        await f.call(tool);
        expect(f.internals.rehydrationReservations.get(BASE)).toBe(replacement);
        expect(replacement.restartHandoff).toBe(true);
        expect(await f.persistence.getSession!(BASE)).toEqual(row);
      });
      for (const requester of [undefined, "other-session"]) {
        test(`${platform} ${tool}: unheld unreserved × ${requester ?? "sessionless"}`, async () => {
          const f = await fixture(platform, false, false, "owner-conn", false);
          await f.sessions.releaseSession(BASE, "explicit-release");
          await f.pool.releaseDevice(f.device.deviceId, BASE);
          await f.call(tool, requester);
          expect(f.manager.killed).toEqual([f.device.deviceId]);
        });
      }
      test(`${platform} ${tool}: held by me × owner`, async () => {
        const f = await fixture(platform, false, false, "owner-conn", false);
        await f.call(tool, BASE, false, "owner-conn");
        expect(f.manager.killed).toEqual([f.device.deviceId]);
        expect(await f.persistence.getSession!(BASE)).toMatchObject({
          release_reason: "device-killed",
        });
      });
      for (const requester of [undefined, "other-session"]) {
        for (const force of [false, true]) {
          test(`${platform} ${tool}: held by other × ${requester ?? "sessionless"}, force ${force}`, async () => {
            const f = await fixture(platform, false, false, "owner-conn", false);
            const pending = f.call(tool, requester, force);
            if (force) {
              await pending;
              expect(f.manager.killed).toEqual([f.device.deviceId]);
              expect(await f.persistence.getSession!(BASE)).toMatchObject({
                release_reason: "device-killed",
              });
            } else {
              if (tool === "killDevice") {
                await expect(pending).rejects.toMatchObject({
                  code: "device_owned_by_other_session",
                  retryable: false,
                });
              } else {
                expect(readToolEnvelopePayload(await pending)?.payload).toMatchObject({
                  failure: { code: "device_owned_by_other_session", retryable: false },
                });
              }
              expect(f.manager.killed).toEqual([]);
            }
          });
        }
      }
    }
    test(`${platform} killDevice: reservation retry hint without scheduled deadline`, async () => {
      const f = await fixture(platform);
      const hold = f.internals.rehydrationReservations.get(BASE)!;
      hold.scheduledDeadlineMs = undefined;
      await refusal(f.call("killDevice", "other-session", true), "killDevice", {
        code: "device_owned_by_other_session",
        retryable: true,
        retryAfterMs: 2_000,
      });
      expect(f.manager.killed).toEqual([]);
    });
    test(`${platform} killDevice: confirmed already-stopped sessionless outcome terminalizes R`, async () => {
      const f = await fixture(platform);
      f.manager.beforeKill = () => {
        f.manager.setBootedDevices(platform, []);
        throw new Error(platform === "android" ? "emulator not running" : "already shut down");
      };
      await f.call("killDevice");
      await terminal(f);
    });
    test(`${platform} deleteDevice stopped image: failed destroy changes nothing`, async () => {
      const f = await fixture(platform);
      await f.pool.removeDevice(
        f.device.deviceId,
        true,
        f.pool.getDevice(f.device.deviceId) ?? undefined,
      );
      f.manager.setBootedDevices(platform, []);
      const before = await snapshot(f);
      const destroy = spyOn(f.manager, "destroyDevice").mockRejectedValue(
        new Error("destroy failed"),
      );
      cleanups.push(() => destroy.mockRestore());
      expect(readToolEnvelopePayload(await f.call("deleteDevice"))?.payload).toMatchObject({
        success: false,
        failure: { phase: "destroy" },
      });
      await unchanged(f, before);
    });
    for (const mode of ["unconfirmed", "cancelled", "command timeout"] as const) {
      test(`${platform} deleteDevice stopped image: ${mode} destroy changes nothing`, async () => {
        const f = await fixture(platform);
        await f.pool.removeDevice(
          f.device.deviceId,
          true,
          f.pool.getDevice(f.device.deviceId) ?? undefined,
        );
        f.manager.setBootedDevices(platform, []);
        const before = await snapshot(f);
        const gate = Promise.withResolvers<void>();
        const abort = new AbortController();
        let attempted = false;
        const destroy = spyOn(f.manager, "destroyDevice").mockImplementation(async () => {
          attempted = true;
          if (mode === "cancelled") {
            abort.abort();
          }
          if (mode !== "unconfirmed") {
            await gate.promise;
          }
        });
        cleanups.push(() => destroy.mockRestore());
        const pending = f.call("deleteDevice", undefined, false, undefined, abort.signal);
        try {
          await drainUntil(() => attempted, { description: "stopped image destroy" });
          const response = await settleByFakeEvents(f.timer, pending, { description: mode });
          expect(readToolEnvelopePayload(response)?.payload).toMatchObject({ success: false });
          expect(f.internals.rehydrationReservations.get(BASE)).toBe(before.hold);
          expect(before.hold).toEqual(before.value);
          expect(await f.persistence.getSession!(BASE)).toEqual(before.row);
          expect(f.timer.getPendingTimeouts()).toContain(before.timers[0]);
        } finally {
          gate.resolve();
          await drainMicrotasks(156);
        }
        expect(f.internals.rehydrationReservations.get(BASE)).toBe(before.hold);
      });
    }
    for (const caller of ["other-session", "sessionless", "owner"] as const) {
      test(`${platform} deleteDevice stopped image: reserved × ${caller}`, async () => {
        const f = await fixture(platform);
        await f.pool.removeDevice(
          f.device.deviceId,
          true,
          f.pool.getDevice(f.device.deviceId) ?? undefined,
        );
        f.manager.setBootedDevices(platform, []);
        const before = await snapshot(f);
        const pending = f.call(
          "deleteDevice",
          caller === "sessionless" ? undefined : caller === "owner" ? BASE : caller,
        );
        if (caller === "other-session") {
          await refusal(pending, "deleteDevice", {
            code: "device_owned_by_other_session",
            retryable: true,
            retryAfterMs: before.hold.scheduledDeadlineMs! - f.sessions.sessionNow(),
          });
          await unchanged(f, before);
          expect(
            f.manager.getExecutedOperations().filter((op) => op.startsWith("destroyDevice")),
          ).toEqual([]);
        } else {
          expect(await pending).toMatchObject({ structuredContent: { state: "destroyed" } });
          expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
          if (caller === "sessionless") {
            await terminal(f);
          } else {
            expect(await f.persistence.getSession!(BASE)).toEqual(before.row);
          }
        }
        expect(f.manager.killed).toEqual([]);
      });
    }
  }
});
