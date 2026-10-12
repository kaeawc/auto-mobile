import { describe, expect, spyOn } from "bun:test";
import { assertLifecycleCallerHoldsDevice } from "../../src/server/lifecycleDeviceOwnership";
import { InputDeviceOwnedError } from "../../src/daemon/inputDeviceOwnership";
import { drainUntil, drainMicrotasks, settleByFakeEvents } from "../helpers/fakeTimerStepping";
import { BASE, LABEL, SIBLING, restartStopHarness } from "../helpers/restartStopHarness";

describe("lifecycle stops drop the confirmed device-restart hold", () => {
  const { test, fixture, cleanups } = restartStopHarness();

  test("android: reset-cohort capture wins over a reused serial and commits only that image", async () => {
    const f = await fixture("android", true);
    const hold = f.internals.rehydrationReservations.get(LABEL)!;
    const replacement = { ...hold, stableDeviceId: "replacement-avd" };
    f.internals.rehydrationReservations.set(SIBLING, replacement);
    f.pool.getDevice(f.device.deviceId)!.name = "replacement-avd";
    const cohort = Reflect.get(f.pool, "adbServerResetRecoveryReservations") as Map<
      string,
      {
        deviceId: string;
        image: { name: string };
        cancelled?: boolean;
      }
    >;
    const reset = { deviceId: f.device.deviceId, image: { name: f.device.name }, cancelled: false };
    cohort.set("captured-reset", reset);
    const commit = f.pool.markIntentionalShutdown(f.device.deviceId, BASE);
    expect(reset.cancelled).toBe(true);
    expect(f.internals.rehydrationReservations.get(LABEL)).toBe(hold);
    cohort.clear();
    await commit();
    expect(f.internals.rehydrationReservations.has(LABEL)).toBe(false);
    expect(f.internals.rehydrationReservations.get(SIBLING)).toBe(replacement);
    expect(replacement.restartHandoff).toBe(true);
  });

  test.each(["videoRecording", "exportPlan"] as const)(
    "%s retains the original holder guard for a rival naming reserved R",
    async (toolName) => {
      const f = await fixture("android");
      const hold = f.internals.rehydrationReservations.get(BASE);
      expect(f.sessions.getSession(BASE)).toBeNull();
      expect(() =>
        assertLifecycleCallerHoldsDevice({
          toolName,
          device: f.device,
          requester: { sessionUuid: BASE, mcpSessionId: "rival-conn" },
          force: false,
        }),
      ).not.toThrow();
      expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
      expect(f.manager.killed).toEqual([]);
    },
  );
  for (const platform of ["android", "ios"] as const) {
    test(`${platform}: successful commit keeps a replacement reservation object`, async () => {
      const f = await fixture(platform);
      const hold = f.internals.rehydrationReservations.get(BASE)!;
      const commit = f.pool.releaseDeviceRestartReservationForStop(f.device.deviceId, BASE);
      expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
      const replacement = { ...hold };
      f.internals.rehydrationReservations.set(BASE, replacement);
      await commit();
      expect(f.internals.rehydrationReservations.get(BASE)).toBe(replacement);
      expect(replacement.restartHandoff).toBe(true);
    });
    test(`${platform}: successful commit uses the mark-time identity after pooled eviction`, async () => {
      const f = await fixture(platform);
      const commit = f.pool.releaseDeviceRestartReservationForStop(f.device.deviceId, BASE);
      await f.pool.removeDevice(f.device.deviceId, true, f.pool.getDevice(f.device.deviceId));
      expect(f.internals.rehydrationReservations.get(BASE)?.restartHandoff).toBe(true);
      await commit();
      expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
    });
    test(`${platform}: successful commit uses mark-time live label resolution`, async () => {
      const f = await fixture(platform, true);
      const commit = f.pool.releaseDeviceRestartReservationForStop(f.device.deviceId, SIBLING);
      f.sessions.setDeviceLabels(BASE, {});
      await commit();
      expect(f.internals.rehydrationReservations.has(LABEL)).toBe(false);
    });
    test(`${platform}: disconnected handoff owner snapshot still refuses rival stop`, async () => {
      const f = await fixture(platform);
      const hold = f.internals.rehydrationReservations.get(BASE)!;
      f.pool.releaseMcpSessionBindings("owner-conn");
      expect(hold.ownerMcpSessionIds).toEqual(new Set(["owner-conn"]));
      await expect(f.call("killDevice", BASE, true, "rival-conn")).rejects.toBeInstanceOf(
        InputDeviceOwnedError,
      );
      expect(f.manager.killed).toEqual([]);
      expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
    });
    for (const mode of ["throws", "cancelled", "command timeout", "unconfirmed"] as const) {
      test(`${platform}: holder killDevice ${mode} preserves the exact hold and timer`, async () => {
        const f = await fixture(platform);
        const hold = f.internals.rehydrationReservations.get(BASE)!;
        const snapshot = { ...hold };
        const abort = new AbortController();
        const gate = Promise.withResolvers<void>();
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
        const pending = f.call("killDevice", BASE, false, "owner-conn", abort.signal).then(
          () => undefined,
          (error: unknown) => error,
        );
        await drainUntil(() => f.manager.killed.length === 1, { description: "platform kill" });
        const error = await settleByFakeEvents(f.timer, pending, { description: mode });
        try {
          expect(error).toBeInstanceOf(Error);
          if (mode === "throws") {
            expect(String(error)).toContain("platform stop failed");
          }
          if (mode === "command timeout" || mode === "unconfirmed") {
            expect(error).toMatchObject({ code: "timeout" });
          }
          expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
          expect(hold).toEqual(snapshot);
          expect(f.pool.genericAvailability(f.device.deviceId)).toBe("reserved");
          expect(
            f.pool.restartReservationForStart(platform, [f.device.deviceId], { sessionUuid: BASE })!
              .owned,
          ).toBe(true);
        } finally {
          // Settle the fake command to release retained stop/lease fences, even on regression.
          gate.resolve();
          await drainMicrotasks(156);
        }
        // Late completion of a failed call leaves the hold to its original window.
        expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
        expect(hold).toEqual(snapshot);
      });
    }
    test(`${platform}: the holder's in-flight stop never opens the restart hold`, async () => {
      const f = await fixture(platform);
      const hold = f.internals.rehydrationReservations.get(BASE)!;
      const snapshot = { ...hold };
      let observed = false;
      f.manager.beforeKill = async () => {
        observed = true;
        expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
        expect(hold).toEqual(snapshot);
        expect(
          f.pool.restartReservationForStart(platform, [f.device.deviceId], {
            sessionUuid: "rival",
            mcpSessionId: "rival-conn",
          }),
        ).toMatchObject({ owned: false, restartHandoff: true });
        await expect(
          f.pool.bindOrReuseDeviceSession(
            "rival",
            f.device.deviceId,
            platform,
            undefined,
            undefined,
            f.device,
          ),
        ).rejects.toThrow();
      };
      await f.call("killDevice", BASE, false, "owner-conn");
      expect(observed).toBe(true);
      expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
    });
    test(`${platform}: holder deleteDevice stop failure keeps the exact hold`, async () => {
      const f = await fixture(platform);
      const hold = f.internals.rehydrationReservations.get(BASE)!;
      const snapshot = { ...hold };
      f.manager.beforeKill = () => {
        throw new Error("platform stop failed");
      };
      expect(
        JSON.parse((await f.call("deleteDevice", BASE, false, "owner-conn")).content[0].text),
      ).toMatchObject({ success: false, failure: { phase: "stop" } });
      expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
      expect(hold).toEqual(snapshot);
      expect(f.pool.genericAvailability(f.device.deviceId)).toBe("reserved");
    });
    for (const tool of ["killDevice", "deleteDevice"] as const) {
      test(`${platform}: ${tool} rechecks the handoff owner under the shutdown lock`, async () => {
        const f = await fixture(platform);
        const original = f.pool.reserveDeviceForShutdown.bind(f.pool);
        const recheck = spyOn(f.pool, "reserveDeviceForShutdown").mockImplementation(
          async (...args) => {
            f.internals.rehydrationReservations.get(BASE)!.ownerMcpSessionIds = new Set([
              "replacement-owner",
            ]);
            return await original(...args);
          },
        );
        cleanups.push(() => recheck.mockRestore());
        const result = f.call(tool, BASE, true, "owner-conn");
        if (tool === "killDevice") {
          await expect(result).rejects.toBeInstanceOf(InputDeviceOwnedError);
        } else {
          expect(JSON.parse((await result).content[0].text)).toMatchObject({
            failure: { code: "device_owned_by_other_session", phase: "stop" },
          });
        }
        expect(recheck).toHaveBeenCalledTimes(1);
        expect(f.manager.killed).toEqual([]);
        expect(f.internals.rehydrationReservations.get(BASE)?.restartHandoff).toBe(true);
        expect(f.internals.intentionalShutdowns.size).toBe(0);
        expect(f.internals.isReservedForShutdown(f.pool.getDevice(f.device.deviceId)!)).toBe(false);
      });
      for (const force of [false, true]) {
        test(`${platform}: ${tool} refuses the rival naming the holder, force ${force}`, async () => {
          const f = await fixture(platform);
          const hold = f.internals.rehydrationReservations.get(BASE)!;
          expect(hold.ownerMcpSessionIds).toEqual(new Set(["owner-conn"]));
          const snapshot = { ...hold };
          const row = { ...(await f.persistence.getSession!(BASE)) };
          const device = f.pool.getDevice(f.device.deviceId);
          const deviceSnapshot = { ...device };
          const shutdownReservation = spyOn(f.pool, "reserveDeviceForShutdown");
          cleanups.push(() => shutdownReservation.mockRestore());
          const pending = f.call(tool, BASE, force, "rival-conn");
          if (tool === "killDevice") {
            const error = await pending.then(
              () => undefined,
              (error: unknown) => error,
            );
            expect(error).toBeInstanceOf(InputDeviceOwnedError);
            expect(error).toMatchObject({
              code: "device_owned_by_other_session",
              retryable: false,
            });
            expect((error as Error).message).toBe(
              `killDevice refused: device '${f.device.deviceId}' is reserved for session ${BASE}'s device-restart recovery, and this connection did not own that session when the device restarted. Call from the owning connection, or wait for the recovery window to end. force: true does not override naming another client's session.`,
            );
          } else {
            expect(JSON.parse((await pending).content[0].text)).toMatchObject({
              success: false,
              failure: {
                code: "device_owned_by_other_session",
                phase: "precondition",
                retryable: false,
                message: `deleteDevice refused: device '${f.device.deviceId}' is reserved for session ${BASE}'s device-restart recovery, and this connection did not own that session when the device restarted. Call from the owning connection, or wait for the recovery window to end. force: true does not override naming another client's session.`,
              },
            });
          }
          expect(f.manager.killed).toEqual([]);
          expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
          expect(hold).toEqual(snapshot);
          expect(await f.persistence.getSession!(BASE)).toEqual(row);
          expect(f.pool.getDevice(f.device.deviceId)).toBe(device);
          expect(device).toEqual(deviceSnapshot);
          expect(shutdownReservation).not.toHaveBeenCalled();
          expect(f.internals.intentionalShutdowns.size).toBe(0);
        });
      }
      for (const connection of ["owner-conn", "rival-conn"]) {
        test(`${platform}: ${tool} live-base label requester uses handoff connection ${connection}`, async () => {
          const f = await fixture(platform, true);
          expect(f.internals.rehydrationReservations.get(LABEL)!.ownerMcpSessionIds).toEqual(
            new Set(["owner-conn"]),
          );
          const result = f.call(tool, SIBLING, false, connection);
          if (connection === "rival-conn") {
            if (tool === "killDevice") {
              await expect(result).rejects.toBeInstanceOf(InputDeviceOwnedError);
            } else {
              expect(JSON.parse((await result).content[0].text)).toMatchObject({
                failure: { code: "device_owned_by_other_session" },
              });
            }
            expect(f.manager.killed).toEqual([]);
            expect(f.internals.rehydrationReservations.get(LABEL)?.restartHandoff).toBe(true);
          } else {
            await result;
            expect(f.manager.killed).toEqual([f.device.deviceId]);
            expect(f.internals.rehydrationReservations.has(LABEL)).toBe(false);
          }
        });
      }
      test(`${platform}: ${tool} owner connection drops its hold on success`, async () => {
        const f = await fixture(platform);
        await f.call(tool, BASE, false, "owner-conn");
        expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
      });
      for (const owners of [undefined, new Set<string>()]) {
        test(`${platform}: ${tool} ${owners === undefined ? "undefined" : "empty"} owner snapshot permits rival connection`, async () => {
          const f = await fixture(platform, false, false, null);
          expect(f.internals.rehydrationReservations.get(BASE)!.ownerMcpSessionIds?.size ?? 0).toBe(
            0,
          );
          f.internals.rehydrationReservations.get(BASE)!.ownerMcpSessionIds = owners;
          await f.call(tool, BASE, false, "rival-conn");
          expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
        });
      }
      for (const requester of [undefined, "other-session"]) {
        test(`${platform}: ${tool} rival connection with requester ${requester ?? "none"} follows reserved stop policy`, async () => {
          const f = await fixture(platform);
          const hold = f.internals.rehydrationReservations.get(BASE)!;
          const pending = f.call(tool, requester, true, "rival-conn");
          if (requester) {
            if (tool === "killDevice") {
              await expect(pending).rejects.toMatchObject({
                code: "device_owned_by_other_session",
                retryable: true,
              });
            } else {
              expect(JSON.parse((await pending).content[0].text)).toMatchObject({
                failure: { code: "device_owned_by_other_session", retryable: true },
              });
            }
            expect(f.manager.killed).toEqual([]);
            expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
            expect(hold.restartHandoff).toBe(true);
          } else {
            await pending;
            expect(f.manager.killed).toEqual([f.device.deviceId]);
            expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
            expect(await f.persistence.getSession!(BASE)).toMatchObject({
              release_reason: "device-killed",
            });
          }
        });
      }
    }
    for (const tool of ["killDevice", "deleteDevice"] as const) {
      test(`${platform}: ${tool} already-stopped success drops the captured hold`, async () => {
        const f = await fixture(platform);
        f.manager.beforeKill = () => {
          f.manager.setBootedDevices(platform, []);
          throw new Error(platform === "android" ? "emulator not running" : "already shut down");
        };
        await f.call(tool, BASE, false, "owner-conn");
        expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
      });
    }
    test(`${platform}: reserving session's killDevice drops its hold`, async () => {
      const f = await fixture(platform);
      await f.kill(BASE);
      expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
      expect(f.pool.genericAvailability(f.device.deviceId)).not.toBe("reserved");
    });
    for (const requester of [BASE, SIBLING]) {
      test(`${platform}: live base resolves label holder for requester ${requester}`, async () => {
        const f = await fixture(platform, true);
        expect(f.sessions.getDeviceLabels(BASE)).toEqual({ phone: LABEL, tablet: SIBLING });
        await f.kill(requester);
        expect(f.internals.rehydrationReservations.has(LABEL)).toBe(false);
        expect(f.pool.genericAvailability(f.device.deviceId)).not.toBe("reserved");
      });
    }
    test(`${platform}: handed-off base cannot resolve its label requester and refuses the stop`, async () => {
      const f = await fixture(platform, false, true);
      expect(f.sessions.getDeviceLabels(BASE)).toBeUndefined();
      await expect(f.call("killDevice", LABEL)).rejects.toMatchObject({
        code: "device_owned_by_other_session",
        retryable: true,
      });
      expect(f.manager.killed).toEqual([]);
      expect(f.internals.rehydrationReservations.get(BASE)?.restartHandoff).toBe(true);
      expect(f.pool.genericAvailability(f.device.deviceId)).toBe("reserved");
    });
    for (const force of [false, true]) {
      test(`${platform}: another session's killDevice is refused and preserves the hold, force ${force}`, async () => {
        const f = await fixture(platform);
        await expect(f.call("killDevice", "other-session", force)).rejects.toMatchObject({
          code: "device_owned_by_other_session",
          retryable: true,
        });
        expect(f.manager.killed).toEqual([]);
        expect(f.internals.rehydrationReservations.get(BASE)?.restartHandoff).toBe(true);
        expect(f.pool.genericAvailability(f.device.deviceId)).toBe("reserved");
      });
    }
    test(`${platform}: sessionless killDevice ends the hold and terminalizes R`, async () => {
      const f = await fixture(platform);
      await f.kill();
      expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
      expect(f.pool.genericAvailability(f.device.deviceId)).not.toBe("reserved");
      expect(await f.persistence.getSession!(BASE)).toMatchObject({
        release_reason: "device-killed",
      });
    });
    test(`${platform}: holder stop preserves the daemon-restart source`, async () => {
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
      await f.kill(BASE);
      expect(f.internals.rehydrationReservations.get(BASE)).toMatchObject({
        restartHandoff: false,
        daemonRehydration: true,
      });
      expect(f.pool.genericAvailability(f.device.deviceId)).toBe("reserved");
      f.pool.releaseRehydrationReservation(BASE);
      expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
    });
    test(`${platform}: reserving session's deleteDevice drops its hold`, async () => {
      const f = await fixture(platform);
      const response = await f.call("deleteDevice", BASE);
      expect(response).toMatchObject({
        structuredContent: { state: "destroyed", command: { stop: "accepted" } },
      });
      expect(f.manager.killed).toEqual([f.device.deviceId]);
      expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
      if (platform === "ios") {
        expect(f.internals.intentionalShutdowns.size).toBe(0);
      }
    });
  }
});
