import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { createListingHandlers } from "../../src/server/deviceToolsListing";
import {
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { AndroidTransportAliases, withAndroidTransportId } from "../../src/utils/androidSerial";
import { createExecResult } from "../../src/utils/execResult";
import { AndroidAvdProvenanceCache } from "../../src/utils/AndroidAvdProvenanceCache";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

type Outcome = "success" | "failure" | "timeout";
interface Snapshot {
  count: number;
  outcomes: readonly Outcome[];
  offset?: number;
}
interface Schedule {
  name: string;
  snapshots: readonly Snapshot[];
}
const success: readonly Outcome[] = ["success", "success", "success"];
// fastCheckConfig.ts is absent in this worktree: use the requested fixed-table
// fallback. Six layouts × eight schedules = 48 deterministic cases, no filters.
// Each case performs two or three refreshes with acquisitions between them.
const schedules: readonly Schedule[] = [
  { name: "all succeed", snapshots: [1, 2, 3].map((count) => ({ count, outcomes: success })) },
  {
    name: "USB fails beside proof",
    snapshots: [
      { count: 2, outcomes: ["failure", "success", "timeout"] },
      { count: 3, outcomes: ["timeout", "success", "success"] },
      { count: 2, outcomes: success },
    ],
  },
  {
    name: "proof arrives after acquisition",
    snapshots: [
      { count: 2, outcomes: ["failure", "timeout", "failure"] },
      { count: 2, outcomes: ["failure", "success", "timeout"] },
      { count: 3, outcomes: success },
    ],
  },
  {
    name: "timeouts recover",
    snapshots: [
      { count: 3, outcomes: ["timeout", "timeout", "timeout"] },
      { count: 3, outcomes: success },
    ],
  },
  {
    name: "wireless failures recover",
    snapshots: [
      { count: 3, outcomes: ["success", "failure", "timeout"] },
      { count: 2, outcomes: ["success", "timeout", "failure"] },
      { count: 3, outcomes: success },
    ],
  },
  {
    name: "all probes fail",
    snapshots: [1, 2, 3].map((count) => ({
      count,
      outcomes: ["failure", "timeout", "failure"],
    })),
  },
  {
    name: "cached proof survives failures",
    snapshots: [
      { count: 3, outcomes: success },
      { count: 2, offset: 1, outcomes: ["failure", "failure", "failure"] },
      { count: 1, offset: 2, outcomes: ["timeout", "timeout", "timeout"] },
    ],
  },
  {
    name: "wireless first then USB",
    snapshots: [
      { count: 1, outcomes: success },
      { count: 3, outcomes: ["failure", "timeout", "success"] },
      { count: 2, outcomes: success },
    ],
  },
];
const layouts = [
  ["physical"],
  ["emulator"],
  ["physical", "physical"],
  ["physical", "emulator"],
  ["emulator", "physical"],
  ["emulator", "emulator"],
] as const;
const cases = layouts.flatMap((layout, layoutIndex) =>
  schedules.map((schedule, scheduleIndex) => ({
    label: `${layout.join("+")}: ${schedule.name}`,
    layout,
    schedule,
    index: layoutIndex * schedules.length + scheduleIndex,
  })),
);

function phone(kind: "physical" | "emulator", index: number, wirelessFirst: boolean) {
  const serial = kind === "physical" ? `PHONE-${index}` : "EMULATOR-SERIAL";
  const consolePort = 5554 + index * 2;
  const ids =
    kind === "physical"
      ? [serial, `phone-${index}:5555`, `phone-${index}:7777`]
      : [`emulator-${consolePort}`, `localhost:${consolePort + 1}`, `127.0.0.1:${consolePort + 1}`];
  if (wirelessFirst) {
    ids.push(ids.shift()!);
  }
  return {
    kind,
    serial,
    bootId: `boot-${index}`,
    name: kind === "emulator" ? `Pixel-${index}` : `Phone-${index}`,
    key: kind === "emulator" ? `console:${consolePort}` : JSON.stringify([serial, `boot-${index}`]),
    ids,
  };
}

describe("Android alias invariants across refreshes and acquisitions (#10201)", () => {
  test.each(cases)("$label", async ({ layout, schedule, index }) => {
    const timer = new FakeTimer();
    const manager = new FakeDeviceUtils();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const phones = layout.map((kind, position) =>
      phone(kind, position, schedule.name === "wireless first then USB"),
    );
    const clients = new Map<string, FakeAdbExecutor>();
    const keys = new Map(
      phones.flatMap((entry) => entry.ids.map((id) => [id, entry.key] as const)),
    );
    const factory = {
      create: (target?: BootedDevice | null) => {
        const client = clients.get(target?.deviceId ?? "");
        if (!client) {
          throw new Error(`Unexpected probe: ${target?.deviceId}`);
        }
        return client;
      },
    };
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "invariant-daemon", {
        timer,
        idGenerator: new FakeIdGenerator(),
        deviceManager: manager,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        androidAdbFactory: factory,
      }),
    );
    const held = new Map<string, { sessionId: string; incarnation: number | undefined }>();
    const provenTransports = new Set<string>();
    const aliases = pool.getAndroidTransportRouting();
    if (!(aliases instanceof AndroidTransportAliases)) {
      throw new Error("Expected the pool's Android alias routing seam");
    }
    DaemonState.getInstance().initialize(sessions, pool);
    setDeviceToolsDependencies({
      timer,
      deviceManagerFactory: () => manager,
      androidAdbFactory: factory,
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
      displayInventory: { hydrate: async (device) => device, invalidate: () => {} },
    });
    const listDevices = createListingHandlers().listDevicesHandler;
    try {
      for (const [refresh, snapshot] of schedule.snapshots.entries()) {
        const rows: BootedDevice[] = [];
        const snapshotPhones = phones.map((entry) => ({
          ...entry,
          ids: entry.ids.slice(snapshot.offset ?? 0, (snapshot.offset ?? 0) + snapshot.count),
        }));
        for (const [position, entry] of snapshotPhones.entries()) {
          for (const [rowIndex, deviceId] of entry.ids.entries()) {
            const adb = new FakeAdbExecutor();
            adb.setCommandResponse("ro.serialno", createExecResult(entry.serial, ""));
            adb.setCommandResponse(
              "ro.kernel.qemu",
              createExecResult(entry.kind === "emulator" ? "1" : "0", ""),
            );
            adb.setCommandResponse("ro.boot.qemu.avd_name", createExecResult(entry.name, ""));
            adb.setCommandResponse("boot_id", createExecResult(entry.bootId, ""));
            const outcome = snapshot.outcomes[(rowIndex + position) % snapshot.outcomes.length];
            if (outcome === "success" || deviceId.startsWith("emulator-")) {
              provenTransports.add(deviceId);
            }
            if (outcome !== "success") {
              const command = [
                "ro.serialno",
                "ro.kernel.qemu",
                entry.kind === "emulator" ? "ro.boot.qemu.avd_name" : "boot_id",
              ][(index + refresh + rowIndex) % 3];
              // A timeout is a settled executor rejection, not a real sleep.
              adb.setCommandError(
                command,
                outcome === "timeout"
                  ? new DOMException("Probe deadline", "TimeoutError")
                  : new Error("Probe failed"),
              );
            }
            clients.set(deviceId, adb);
            rows.push(
              withAndroidTransportId({ deviceId, name: entry.name, platform: "android" }, deviceId),
            );
          }
        }
        for (const id of provenTransports) {
          if (!rows.some((row) => row.deviceId === id)) {
            provenTransports.delete(id);
          }
        }
        manager.setBootedDevices("android", rows);
        // I4: neither a swallowed refresh failure nor a listing rejection is allowed.
        expect((await pool.refreshDevicesWithOutcome()).failure).toBeUndefined();
        await expect(listDevices({ platform: "android" })).resolves.toBeDefined();

        // I1: include held entries as well as idle assignable capacity. Ground
        // truth comes from the fixture, independently of production alias state.
        const entries = pool.getAllDevices();
        const physicalKeys = entries.map((entry) => keys.get(entry.id));
        expect(physicalKeys.every((key) => key !== undefined)).toBe(true);
        expect(new Set(physicalKeys).size).toBe(entries.length);

        // I2: failures on unchanged proven connections cannot un-fold a holder,
        // remove it, replace its incarnation, or release its owner.
        for (const [id, owner] of held) {
          expect(pool.getDevice(id)?.sessionId).toBe(owner.sessionId);
          expect(pool.getDevice(id)?.incarnation).toBe(owner.incarnation);
          // A live proven peer must keep the holder routable. If every proven
          // connection disappeared, routing to an unidentified peer is unsafe.
          const reachableProof = rows.some(
            (row) => provenTransports.has(row.deviceId) && keys.get(row.deviceId) === keys.get(id),
          );
          if (reachableProof) {
            expect(rows.some((row) => row.deviceId === aliases.resolveTransport(id))).toBe(true);
          }
        }
        // I3: a phone with all successful probes has capacity after this refresh.
        for (const [position, entry] of snapshotPhones.entries()) {
          const allSucceed = entry.ids.every(
            (id, rowIndex) =>
              id.startsWith("emulator-") ||
              snapshot.outcomes[(rowIndex + position) % snapshot.outcomes.length] === "success",
          );
          if (allSucceed) {
            expect(
              entries.some(
                (candidate) =>
                  keys.get(candidate.id) === entry.key &&
                  aliases.isAssignable({
                    deviceId: candidate.id,
                    name: candidate.name,
                    platform: candidate.platform,
                  }) &&
                  (candidate.sessionId !== null || pool.getIdleDevices().includes(candidate)),
              ),
            ).toBe(true);
          }
        }
        for (const idle of pool.getIdleDevices()) {
          const owner = `owner-${index}-${refresh}-${idle.id}`;
          expect(await pool.assignDeviceToSession(owner, "android")).toBe(idle.id);
          held.set(idle.id, {
            sessionId: owner,
            incarnation: pool.getDevice(idle.id)?.incarnation,
          });
        }
        // Check owners immediately, including newly acquired sessions.
        const ownedKeys = pool.getAssignedDevices().map((entry) => keys.get(entry.id));
        expect(new Set(ownedKeys).size).toBe(ownedKeys.length);
        await expect(listDevices({ platform: "android" })).resolves.toBeDefined();
        for (const client of clients.values()) {
          const calls = client.getCommandCalls();
          expect(calls.length).toBeLessThanOrEqual(3);
          expect(calls.every((call) => call.noRetry && call.timeoutMs === 2000)).toBe(true);
        }
      }
      expect(timer.getSleepHistory()).toEqual([]);
    } finally {
      DaemonState.getInstance().reset();
      resetDeviceToolsDependencies();
      AndroidAvdProvenanceCache.resetForTests();
      sessions.stopCleanupTimer();
      timer.reset();
    }
  });
});
