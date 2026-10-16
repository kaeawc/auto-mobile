import { expect, test } from "bun:test";
import { z } from "zod";
import { join } from "node:path";
import { fixture, options as baseOptions, parsed } from "./manualTestPrivateDaemonFixture";
import { BrokerDeviceInfoRefusedError } from "../../scripts/manual-test/brokerDeviceLedger";
import { runPrivateDaemonCommand } from "../../scripts/manual-test/private-daemon";
import { derivePrivateDaemonBatch } from "../../scripts/manual-test/privateDaemonEnv";
import type { HostBaseline } from "../../scripts/manual-test/privateDaemonDevices";
import type {
  DeviceProvenance,
  ProcessEvidence,
} from "../../scripts/manual-test/privateDaemonDeviceEvidence";
// Load the captured fixture as a text asset; command tests never use host filesystem APIs.
const capture: { default: unknown } = await import(
  new URL("../fixtures/manual-test-host/lsof-console-port-listener.txt", import.meta.url).href,
  { with: { type: "text" } }
);
const lsofCapture = z.string().parse(capture.default);
const batchCapture: { default: unknown } = await import(
  new URL("../fixtures/manual-test-host/ps-eww-batch-env.txt", import.meta.url).href,
  { with: { type: "text" } }
);
const emulatorCapture: { default: unknown } = await import(
  new URL(
    "../fixtures/android-boot-admission/ps-snapshot-one-running-emulator.txt",
    import.meta.url,
  ).href,
  { with: { type: "text" } }
);
const psCapture = z.string().parse(batchCapture.default);
const avdCapture = z.string().parse(emulatorCapture.default);
const options = { ...baseOptions, batchDir: "/private/mt batch" };
const baselinePath = join(options.batchDir, "shared/host-devices-at-start.json");
const snapshotPath = join(options.batchDir, "shared/devices-last.json");
function row(
  id = "emulator-5556",
  name = "batch-avd",
  platform: "android" | "ios" = "android",
  isVirtual = true,
) {
  return {
    identity: { stableId: id },
    name,
    platform,
    isVirtual,
    runtime: {
      deviceId: id,
      lifecycle: { state: "booted" },
      poolStatus: "idle",
      heldBy: undefined as string | undefined,
    },
  };
}
async function deviceFixture(protectedDevices: string[] = []) {
  const f = fixture();
  const initCode = await runPrivateDaemonCommand(
    {
      op: "init",
      options: { ...options, ...(protectedDevices.length ? { protectedDevices } : {}) },
    },
    f.deps,
  );
  const manifest = f.files.get(join(options.batchDir, "batch.json"));
  if (initCode !== 0 || manifest === undefined) {
    throw new Error(
      `fixture init failed (exit ${initCode}); logs: ${f.logs.join(" | ")}; files: ${[...f.files.keys()].join(", ")}`,
    );
  }
  f.files.set(
    baselinePath,
    JSON.stringify({ recordedAt: "2026-10-13T00:00:00.000Z", android: ["preexisting"], ios: [] }),
  );
  const frames: Array<{ path: string; method: string; params?: unknown; timeoutMs: number }> = [];
  f.deps.runCapture = async (cmd, args, env, timeoutMs) => {
    f.captures.push({ command: cmd, args, env, timeoutMs });
    return { exitCode: 0, stdout: cmd === "ps" ? psCapture : lsofCapture, stderr: "" };
  };
  f.deps.requestSocket = async (path, request) => {
    frames.push({ path, ...request });
    return {
      success: true,
      result:
        request.params && (request.params as { name: string }).name === "listDevices"
          ? { structuredContent: { devices: [row()] } }
          : { content: [{ type: "text", text: '{"success":true}' }] },
    };
  };
  return { ...f, frames };
}
function command(op: string, ...flags: string[]) {
  return parsed([op, "--batch-dir", options.batchDir, ...flags]);
}
function document(f: { logs: string[] }) {
  return JSON.parse(f.logs.at(-1)!);
}
function inventoryRows(
  f: Awaited<ReturnType<typeof deviceFixture>>,
  devices: ReturnType<typeof row>[],
) {
  const request = f.deps.requestSocket;
  f.deps.requestSocket = async (path, frame) => {
    if ((frame.params as { name: string }).name === "listDevices") {
      f.frames.push({ path, ...frame });
      return { success: true, result: { structuredContent: { devices } } };
    }
    return request(path, frame);
  };
}
function killFrames(f: Awaited<ReturnType<typeof deviceFixture>>) {
  return f.frames.filter((frame) => (frame.params as { name: string }).name === "killDevice");
}

test("F1 process evidence reads real captures without splitting a batch path containing spaces", async () => {
  const { parseProcessEvidence } =
    await import("../../scripts/manual-test/privateDaemonDeviceEvidence");
  expect(parseProcessEvidence(psCapture, "/private/mt batch")).toEqual({
    batchMarker: true,
    daemonIndex: 2,
  });
  for (const batchDir of ["/private/mt", "/private/mt batch2", "/absent"]) {
    expect(parseProcessEvidence(psCapture, batchDir)).toMatchObject({
      batchMarker: false,
      daemonIndex: 2,
    });
  }
  expect(parseProcessEvidence(avdCapture, options.batchDir)).toEqual({
    batchMarker: false,
    processAvdName: "amslot-039fd12f-0-g1-5e7e5f80",
  });
  expect(parseProcessEvidence(psCapture.split(" MT_DAEMON=")[0], options.batchDir)).toEqual({
    batchMarker: true,
  });
});
test("F1 positive and negative evidence override baseline; missing evidence uses all baseline states", async () => {
  const { classifyDevice } = await import("../../scripts/manual-test/privateDaemonDevices");
  const device = { deviceId: "id", name: "avd", platform: "android" as const };
  const cases: Array<[HostBaseline | undefined, ProcessEvidence | undefined, DeviceProvenance]> = [
    [{ android: [], ios: [] }, { batchMarker: true, daemonIndex: 2 }, "batch-booted"],
    [{ android: ["id"], ios: [] }, { batchMarker: true }, "batch-booted"],
    [{ android: [], ios: [] }, { batchMarker: false }, "foreign"],
    [{ android: ["id"], ios: [] }, { batchMarker: false }, "foreign"],
    [{ android: ["id"], ios: [] }, undefined, "preexisting"],
    [{ android: [], ios: [] }, undefined, "batch-inferred"],
    [undefined, undefined, "unknown"],
    [{ android: { unavailable: "unreadable" }, ios: [] }, undefined, "unknown"],
  ];
  for (const [baseline, evidence, provenance] of cases) {
    expect(classifyDevice(device, baseline, [], evidence).provenance).toBe(provenance);
  }
});
test.each(["ambroker-039fd12f-0-g1-nonce", "amslot-039fd12f-0-g1-nonce"])(
  "broker name %s is display evidence and never authorizes shutdown",
  async (name) => {
    for (const state of ["inferred", "preexisting", "protected", "batch-evidence"]) {
      const f = await deviceFixture(state === "protected" ? [name] : []);
      const device = row("sim-broker", name, "ios");
      inventoryRows(f, [device]);
      if (state === "preexisting") {
        f.files.set(baselinePath, JSON.stringify({ android: [], ios: ["sim-broker"] }));
      }
      if (state === "batch-evidence") {
        // Android can supply positive process evidence; naming must still not grant permission.
        inventoryRows(f, [row("emulator-5556", name)]);
      }
      expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
      expect(document(f).devices[0]).toMatchObject({
        provenance: "broker-owned",
        protected: state === "protected",
      });
      const id = state === "batch-evidence" ? "emulator-5556" : "sim-broker";
      expect(
        await runPrivateDaemonCommand(command("shutdown-devices", "--device", id), f.deps),
      ).toBe(1);
      expect(document(f).results[0].outcome).toBe(
        state === "protected" ? "protected" : "not-batch-booted",
      );
      expect(killFrames(f)).toEqual([]);
    }
  },
);
test("F1 default shutdown stops only positive emulator and reports inferred simulator", async () => {
  const f = await deviceFixture();
  inventoryRows(f, [row(), row("sim", "simulator", "ios")]);
  expect(await runPrivateDaemonCommand(command("shutdown-devices"), f.deps)).toBe(1);
  expect(killFrames(f)).toHaveLength(1);
  expect(document(f).results).toMatchObject([
    { outcome: "stopped", provenance: "batch-booted", bootedBy: "daemon2" },
    {
      outcome: "inferred-not-stopped",
      provenance: "batch-inferred",
      message: expect.stringContaining("--device"),
    },
  ]);
});
test("F1 explicitly checked inferred simulator receives exactly one frame", async () => {
  const f = await deviceFixture();
  inventoryRows(f, [row("sim", "simulator", "ios"), row("other-sim", "other simulator", "ios")]);
  expect(
    await runPrivateDaemonCommand(command("shutdown-devices", "--device", "sim"), f.deps),
  ).toBe(0);
  expect(killFrames(f)).toHaveLength(1);
  expect(killFrames(f)[0].params).toEqual({
    name: "killDevice",
    arguments: { device: { deviceId: "sim", name: "simulator", platform: "ios" } },
  });
  expect(document(f).results[0]).toMatchObject({
    outcome: "stopped",
    provenance: "batch-inferred",
  });
});
test.each(["live", "dry-run", "fallback"])(
  "selector safety: shared simulator name is ambiguous in %s",
  async (mode) => {
    const f = await deviceFixture();
    inventoryRows(f, [row("sim-a", "iPhone 16", "ios"), row("sim-b", "iPhone 16", "ios")]);
    if (mode === "fallback") {
      expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
      f.deps.requestSocket = async () => {
        throw new Error("dead");
      };
    }
    expect(
      await runPrivateDaemonCommand(
        command(
          "shutdown-devices",
          "--device",
          "iPhone 16",
          ...(mode === "dry-run" ? ["--dry-run"] : []),
        ),
        f.deps,
      ),
    ).toBe(1);
    expect(document(f).results).toMatchObject([
      { deviceId: "sim-a", outcome: "ambiguous", message: expect.stringContaining("device ID") },
      { deviceId: "sim-b", outcome: "ambiguous", message: expect.stringContaining("device ID") },
    ]);
    expect(killFrames(f)).toEqual([]);
  },
);
test("selector safety: unique inferred name does not authorize shutdown", async () => {
  const f = await deviceFixture();
  inventoryRows(f, [row("sim-a", "iPhone 16", "ios")]);
  expect(
    await runPrivateDaemonCommand(command("shutdown-devices", "--device", "iPhone 16"), f.deps),
  ).toBe(1);
  expect(document(f).results).toMatchObject([
    {
      deviceId: "sim-a",
      outcome: "inferred-not-stopped",
      message: expect.stringContaining("device ID"),
    },
  ]);
  expect(killFrames(f)).toEqual([]);
  inventoryRows(f, [row()]);
  expect(
    await runPrivateDaemonCommand(command("shutdown-devices", "--device", "batch-avd"), f.deps),
  ).toBe(0);
  expect(killFrames(f)).toHaveLength(1);
  expect(killFrames(f)[0].params).toMatchObject({
    arguments: { device: { deviceId: "emulator-5556" } },
  });
});
test("selector safety: exact ID authorizes only its inferred device", async () => {
  const f = await deviceFixture();
  inventoryRows(f, [row("sim-a", "iPhone 16", "ios"), row("sim-b", "iPhone 17", "ios")]);
  expect(
    await runPrivateDaemonCommand(
      command("shutdown-devices", "--device", "sim-a", "--device", "iPhone 17"),
      f.deps,
    ),
  ).toBe(1);
  expect(document(f).results).toMatchObject([
    { deviceId: "sim-a", outcome: "stopped" },
    { deviceId: "sim-b", outcome: "inferred-not-stopped" },
  ]);
  expect(killFrames(f).map((frame) => frame.params)).toEqual([
    {
      name: "killDevice",
      arguments: { device: { deviceId: "sim-a", name: "iPhone 16", platform: "ios" } },
    },
  ]);
});
test.each([false, true])(
  "selector safety: exact ID survives ambiguous name (ID first=%s)",
  async (idFirst) => {
    const f = await deviceFixture();
    inventoryRows(f, [row("sim-a", "iPhone 16", "ios"), row("sim-b", "iPhone 16", "ios")]);
    const selectors = idFirst ? ["sim-a", "iPhone 16"] : ["iPhone 16", "sim-a"];
    expect(
      await runPrivateDaemonCommand(
        command("shutdown-devices", ...selectors.flatMap((selector) => ["--device", selector])),
        f.deps,
      ),
    ).toBe(1);
    expect(document(f).results).toMatchObject([
      { deviceId: "sim-a", outcome: "ambiguous" },
      { deviceId: "sim-b", outcome: "ambiguous" },
      { deviceId: "sim-a", outcome: "stopped" },
    ]);
    expect(killFrames(f).map((frame) => frame.params)).toEqual([
      {
        name: "killDevice",
        arguments: { device: { deviceId: "sim-a", name: "iPhone 16", platform: "ios" } },
      },
    ]);
  },
);
test("selector safety: ID colliding with another name is ambiguous", async () => {
  const f = await deviceFixture();
  inventoryRows(f, [row("sim-a", "iPhone 16", "ios"), row("sim-b", "sim-a", "ios")]);
  expect(
    await runPrivateDaemonCommand(command("shutdown-devices", "--device", "sim-a"), f.deps),
  ).toBe(1);
  expect(document(f).results).toMatchObject([
    { deviceId: "sim-a", outcome: "ambiguous" },
    { deviceId: "sim-b", outcome: "ambiguous" },
  ]);
  expect(killFrames(f)).toEqual([]);
});
test.each(["protected", "foreign", "preexisting", "unknown"])(
  "selector safety: fallback preserves named %s refusal",
  async (kind) => {
    const f = await deviceFixture(kind === "protected" ? ["batch-avd"] : []);
    const signals: number[] = [];
    f.deps.signalPid = (pid) => {
      signals.push(pid);
    };
    expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
    const snapshot = JSON.parse(f.files.get(snapshotPath)!);
    if (kind !== "protected") {
      snapshot.devices[0].provenance = kind;
    }
    f.files.set(snapshotPath, JSON.stringify(snapshot));
    f.deps.requestSocket = async () => {
      throw new Error("dead");
    };
    expect(
      await runPrivateDaemonCommand(command("shutdown-devices", "--device", "batch-avd"), f.deps),
    ).toBe(1);
    expect(document(f).results).toMatchObject([
      {
        deviceId: "emulator-5556",
        outcome: kind === "protected" ? "protected" : "not-batch-booted",
      },
    ]);
    expect(killFrames(f)).toEqual([]);
    expect(signals).toEqual([]);
  },
);
test("selector safety: fallback unique inferred name remains refused", async () => {
  const f = await deviceFixture();
  inventoryRows(f, [row("sim-a", "iPhone 16", "ios")]);
  expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
  f.deps.requestSocket = async () => {
    throw new Error("dead");
  };
  expect(
    await runPrivateDaemonCommand(command("shutdown-devices", "--device", "iPhone 16"), f.deps),
  ).toBe(1);
  expect(document(f).results).toMatchObject([
    {
      deviceId: "sim-a",
      outcome: "inferred-not-stopped",
      message: expect.stringContaining("device ID"),
    },
  ]);
  expect(killFrames(f)).toEqual([]);
});
test.each(["foreign", "preexisting"])("F1 explicit %s never receives a frame", async (kind) => {
  const f = await deviceFixture();
  if (kind === "foreign") {
    f.deps.runCapture = async (cmd) => ({
      exitCode: 0,
      stdout: cmd === "ps" ? avdCapture : lsofCapture,
      stderr: "",
    });
  } else {
    f.deps.runCapture = async () => {
      throw new Error("unreadable");
    };
    f.files.set(baselinePath, JSON.stringify({ android: ["emulator-5556"], ios: [] }));
  }
  expect(
    await runPrivateDaemonCommand(command("shutdown-devices", "--device", "batch-avd"), f.deps),
  ).toBe(1);
  expect(killFrames(f)).toEqual([]);
  expect(document(f).results[0]).toMatchObject({ outcome: "not-batch-booted", provenance: kind });
});
test.each(["reject", "nonzero", "empty"])("F1 ps %s leaves an evidence gap", async (kind) => {
  const f = await deviceFixture();
  const capture = f.deps.runCapture;
  f.deps.runCapture = async (...args) => {
    if (args[0] !== "ps") {
      return capture(...args);
    }
    if (kind === "reject") {
      throw new Error("ps unreadable");
    }
    return { exitCode: kind === "nonzero" ? 1 : 0, stdout: "", stderr: "ps unreadable" };
  };
  expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
  expect(document(f).devices[0]).toMatchObject({
    provenance: "batch-inferred",
    pid: 75134,
    pidReason: expect.any(String),
  });
});
test("F1 conflicting daemon identities remain unknown despite positive process evidence", async () => {
  const f = await deviceFixture();
  f.deps.requestSocket = async (path) => ({
    success: true,
    result: {
      structuredContent: {
        devices: [
          row(
            "emulator-5556",
            path === derivePrivateDaemonBatch(options)[0].socketPath ? "batch-avd" : "different",
          ),
        ],
      },
    },
  });
  expect(
    await runPrivateDaemonCommand(command("shutdown-devices", "--device", "emulator-5556"), f.deps),
  ).toBe(1);
  expect(document(f).results[0]).toMatchObject({
    outcome: "not-batch-booted",
    provenance: "unknown",
  });
});
test.each([false, true])(
  "F2 held-by-other-daemon is refused before frame (explicit=%s)",
  async (explicit) => {
    const f = await deviceFixture();
    inventoryRows(f, [{ ...row(), runtime: { ...row().runtime, heldBy: "other_daemon" } }]);
    expect(
      await runPrivateDaemonCommand(
        command("shutdown-devices", ...(explicit ? ["--device", "batch-avd"] : [])),
        f.deps,
      ),
    ).toBe(1);
    expect(document(f).results[0]).toMatchObject({
      outcome: "held-by-other-daemon",
      provenance: "batch-booted",
    });
    expect(killFrames(f)).toEqual([]);
  },
);
test.each(["stableId", "processAvdName", "placeholder"])(
  "F3 protection by %s sends no frame",
  async (kind) => {
    const avd = "amslot-039fd12f-0-g1-5e7e5f80";
    const f = await deviceFixture([kind === "processAvdName" ? avd : "protected-avd"]);
    const device = row(
      "emulator-5556",
      kind === "placeholder" ? "Unknown (emulator-5556)" : "batch-avd",
    );
    if (kind === "stableId") {
      device.identity.stableId = "protected-avd";
    }
    if (kind === "processAvdName") {
      f.deps.runCapture = async (cmd) => ({
        exitCode: 0,
        stdout: cmd === "ps" ? avdCapture : lsofCapture,
        stderr: "",
      });
    }
    inventoryRows(f, [device]);
    expect(
      await runPrivateDaemonCommand(
        command("shutdown-devices", "--device", "emulator-5556"),
        f.deps,
      ),
    ).toBe(1);
    expect(document(f).results[0].outcome).toBe("protected");
    if (kind === "placeholder") {
      expect(document(f).results[0].message).toContain("could not be read");
    }
    expect(killFrames(f)).toEqual([]);
    if (kind === "processAvdName") {
      expect(JSON.parse(f.files.get(snapshotPath)!).devices[0]).toMatchObject({
        processAvdName: avd,
      });
    }
  },
);
test.each(["refusal", "malformed", "payload", "transport"])(
  "F4 partial %s inventory keeps healthy teardown but exits 1",
  async (kind) => {
    const f = await deviceFixture();
    const request = f.deps.requestSocket;
    f.deps.requestSocket = async (path, frame) => {
      if (path === derivePrivateDaemonBatch(options)[0].socketPath) {
        if (kind === "transport") {
          throw new Error("transport error");
        }
        if (kind === "payload") {
          return { success: true, result: { structuredContent: { invalid: true } } };
        }
        return kind === "refusal"
          ? { success: false, error: "inventory refused" }
          : { invalid: true };
      }
      return request(path, frame);
    };
    expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
    expect(document(f).daemons[0]).toMatchObject({
      name: "P1",
      alive: kind !== "transport",
      error: expect.any(String),
    });
    expect(await runPrivateDaemonCommand(command("shutdown-devices"), f.deps)).toBe(1);
    expect(killFrames(f)).toHaveLength(1);
    expect(document(f)).toMatchObject({
      daemonErrors: [{ name: "P1", error: expect.any(String) }],
      results: [{ outcome: "stopped" }],
    });
  },
);
test("F1 positive evidence works without a baseline even when multiple daemons list the same device", async () => {
  const f = await deviceFixture();
  f.files.delete(baselinePath);
  expect(await runPrivateDaemonCommand(command("shutdown-devices"), f.deps)).toBe(0);
  expect(document(f).results[0]).toMatchObject({
    outcome: "stopped",
    provenance: "batch-booted",
    bootedBy: "daemon2",
  });
});
test("F1 fallback includes positive and inferred snapshots without sending anything", async () => {
  const f = await deviceFixture();
  inventoryRows(f, [row(), row("sim", "simulator", "ios")]);
  expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
  f.frames.length = 0;
  f.deps.requestSocket = async () => {
    throw new Error("daemon dead");
  };
  expect(await runPrivateDaemonCommand(command("shutdown-devices"), f.deps)).toBe(1);
  expect(document(f).results).toMatchObject([
    { outcome: "daemon-dead", provenance: "batch-booted", bootedBy: "daemon2" },
    { outcome: "daemon-dead", provenance: "batch-inferred" },
  ]);
  expect(killFrames(f)).toEqual([]);
});
test("F2 fallback still reports unprotected snapshot devices held by another daemon", async () => {
  const f = await deviceFixture();
  inventoryRows(f, [{ ...row(), runtime: { ...row().runtime, heldBy: "other_daemon" } }]);
  expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
  f.deps.requestSocket = async () => {
    throw new Error("daemon dead");
  };
  expect(await runPrivateDaemonCommand(command("shutdown-devices"), f.deps)).toBe(1);
  expect(document(f).results[0]).toMatchObject({
    provenance: "batch-booted",
    outcome: "held-by-other-daemon",
  });
  expect(killFrames(f)).toEqual([]);
});
test.each(["other_daemon", "future_holder", ""])(
  "F2 second view's hold %s is retained",
  async (heldBy) => {
    const f = await deviceFixture();
    const request = f.deps.requestSocket;
    f.deps.requestSocket = async (path, frame) => {
      if (path === derivePrivateDaemonBatch(options)[1].socketPath) {
        return {
          success: true,
          result: {
            structuredContent: {
              devices: [{ ...row(), runtime: { ...row().runtime, heldBy } }],
            },
          },
        };
      }
      return request(path, frame);
    };
    expect(await runPrivateDaemonCommand(command("shutdown-devices"), f.deps)).toBe(1);
    expect(document(f).results[0].outcome).toBe(
      heldBy === "other_daemon" ? "held-by-other-daemon" : "broker-held",
    );
    expect(killFrames(f)).toEqual([]);
  },
);
test("a session_broker hold without ledger or broker-name evidence does not classify a plain emulator as broker-held", async () => {
  const f = await deviceFixture();
  inventoryRows(f, [{ ...row(), runtime: { ...row().runtime, heldBy: "session_broker" } }]);
  expect(
    await runPrivateDaemonCommand(
      command("shutdown-devices", "--dry-run", "--device", "emulator-5556"),
      f.deps,
    ),
  ).toBe(0);
  expect(document(f).results[0].outcome).not.toBe("broker-held");
  // A broker-named device with the same hold stays broker-held, and nothing is ever force-stopped.
  inventoryRows(f, [
    {
      ...row("emulator-5556", "ambroker-held"),
      runtime: { ...row().runtime, heldBy: "session_broker" },
    },
  ]);
  await runPrivateDaemonCommand(
    command("shutdown-devices", "--dry-run", "--device", "emulator-5556"),
    f.deps,
  );
  expect(document(f).results[0].outcome).toBe("broker-held");
  expect(killFrames(f)).toEqual([]);
});
test("F2 unknown snapshot hold is parsed and never suggests stopping by PID", async () => {
  const f = await deviceFixture();
  inventoryRows(f, [{ ...row(), runtime: { ...row().runtime, heldBy: "future_holder" } }]);
  expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
  f.deps.requestSocket = async () => {
    throw new Error("daemon dead");
  };
  expect(await runPrivateDaemonCommand(command("shutdown-devices"), f.deps)).toBe(1);
  expect(document(f).results[0]).toMatchObject({ outcome: "broker-held" });
  expect(document(f).results[0].message).not.toContain("PID");
  expect(killFrames(f)).toEqual([]);
});
test.each(["managed_slot", "future_holder", ""])(
  "F2 any broker hold %s is parsed and refused without a stop frame",
  async (heldBy) => {
    const f = await deviceFixture();
    inventoryRows(f, [{ ...row(), runtime: { ...row().runtime, heldBy } }]);
    expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
    expect(document(f).devices[0].heldBy).toBe(heldBy);
    for (const flags of [[], ["--device", "emulator-5556"], ["--dry-run"]]) {
      expect(await runPrivateDaemonCommand(command("shutdown-devices", ...flags), f.deps)).toBe(1);
      expect(document(f).results[0]).toMatchObject({
        outcome: "broker-held",
        message: expect.stringContaining("broker-held"),
      });
    }
    expect(killFrames(f)).toEqual([]);
  },
);
test.each([
  ["devices", "inventory refused"],
  ["shutdown-devices", "inventory refused"],
  ["devices", ""],
  ["shutdown-devices", ""],
])("F4 all refusing inventories make %s exit 1 (message=%s)", async (op, error) => {
  const f = await deviceFixture();
  f.deps.requestSocket = async () => ({ success: false, error });
  expect(await runPrivateDaemonCommand(command(op), f.deps)).toBe(1);
  expect(document(f).daemonErrors).toEqual([
    { name: "P1", error },
    { name: "P2", error },
  ]);
});
test("F6 product already-stopped nested text error is stopped and keeps message", async () => {
  const f = await deviceFixture();
  const request = f.deps.requestSocket;
  f.deps.requestSocket = async (path, frame) => {
    if ((frame.params as { name: string }).name === "listDevices") {
      return request(path, frame);
    }
    return {
      success: true,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              message: "Emulator is not running",
              error: { code: "device_already_stopped", message: "Emulator is not running" },
            }),
          },
        ],
      },
    };
  };
  expect(await runPrivateDaemonCommand(command("shutdown-devices"), f.deps)).toBe(0);
  expect(document(f).results[0]).toMatchObject({
    outcome: "stopped",
    code: "device_already_stopped",
    message: "Emulator is not running",
  });
});

test.each(["", "keep-avd", "SIM-UDID"])("protection manifest roundtrip %s", async (protect) => {
  const f = fixture();
  const init = parsed([
    "init",
    "--batch-dir",
    options.batchDir,
    "--count",
    "2",
    "--base-port",
    "3160",
    ...(protect ? ["--protect", protect, "--protect", "other"] : []),
  ]);
  expect(await runPrivateDaemonCommand(init, f.deps)).toBe(0);
  const manifest = JSON.parse(f.files.get(join(options.batchDir, "batch.json"))!);
  if (protect) {
    expect(manifest.options.protectedDevices).toEqual([protect, "other"]);
  } else {
    expect(manifest.options).not.toHaveProperty("protectedDevices");
  }
  expect(await runPrivateDaemonCommand(command("env", "--daemon", "1"), f.deps)).toBe(0);
});
test.each(["", "--bad"])("rejects protection value %s", (value) => {
  expect(() =>
    parsed([
      "init",
      "--batch-dir",
      options.batchDir,
      "--count",
      "1",
      "--base-port",
      "3160",
      "--protect",
      value,
    ]),
  ).toThrow();
});
test.each([
  ["init", "--wait-ms"],
  ["init", "--device"],
  ["init", "--dry-run"],
  ["init", "--timeout-ms"],
  ["start", "--protect"],
  ["status", "--wait-ms"],
  ["stop", "--timeout-ms"],
  ["devices", "--device"],
  ["devices", "--dry-run"],
  ["shutdown-devices", "--protect"],
])("%s refuses out-of-command flag %s", (op, flag) => {
  expect(() => command(op, "--daemon", "1", flag, "1")).toThrow("Unknown flag");
});
test.each(["devices", "shutdown-devices"])("%s validates timeout and its default", (op) => {
  expect(command(op)).toMatchObject({ timeoutMs: op === "devices" ? 30000 : 60000 });
  for (const value of ["-1", "0", "1.2", "x"]) {
    expect(() => command(op, "--timeout-ms", value)).toThrow("--timeout-ms");
  }
});
test("first start records baseline once before launch; unavailable never blocks start", async () => {
  const f = fixture();
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  f.deps.queryAdbHost = async (_host, _port, request, timeout) => {
    expect(request).toBe("host:devices-l");
    expect(timeout).toBe(10000);
    return "preexisting\tdevice\n";
  };
  f.deps.runCapture = async (_cmd, _args, _env, timeout) => {
    expect(timeout).toBe(10000);
    throw new Error("unavailable");
  };
  const launch = f.deps.runCommand;
  f.deps.runCommand = async (...args) => {
    expect(f.files.has(baselinePath)).toBe(true);
    return launch(...args);
  };
  expect(await runPrivateDaemonCommand(command("start"), f.deps)).toBe(0);
  expect(JSON.parse(f.files.get(baselinePath)!)).toEqual({
    recordedAt: new Date(0).toISOString(),
    android: ["preexisting"],
    ios: { unavailable: "unavailable" },
  });
  const original = f.files.get(baselinePath);
  expect(await runPrivateDaemonCommand(command("start"), f.deps)).toBe(0);
  expect(f.files.get(baselinePath)).toBe(original);
  expect(f.writes.filter((path) => path === baselinePath)).toHaveLength(1);
});
test("pure classifier covers both platforms and missing/unavailable baseline", async () => {
  const { classifyDevice } = await import("../../scripts/manual-test/privateDaemonDevices");
  for (const platform of ["android", "ios"] as const) {
    const device = { deviceId: "id", name: "name", platform };
    expect(classifyDevice(device, { android: ["id"], ios: ["id"] }, ["id"])).toEqual({
      provenance: "preexisting",
      protected: true,
    });
    expect(classifyDevice(device, { android: [], ios: [] }, ["name"])).toEqual({
      provenance: "batch-inferred",
      protected: true,
    });
    expect(classifyDevice(device, undefined, [])).toEqual({
      provenance: "unknown",
      protected: false,
    });
    expect(
      classifyDevice(
        device,
        { android: { unavailable: "down" }, ios: { unavailable: "down" } },
        [],
      ),
    ).toEqual({ provenance: "unknown", protected: false });
  }
});
test("lsof parser uses real captured listener and fails closed on ambiguous output", async () => {
  const { parseLsofPid } = await import("../../scripts/manual-test/privateDaemonDevices");
  expect(parseLsofPid(lsofCapture)).toEqual({ pid: 75134 });
  for (const text of ["", "p1\np2\n", "p0\n", "pbad\n"]) {
    expect(parseLsofPid(text)).toMatchObject({ pid: null, pidReason: expect.any(String) });
  }
  expect(parseLsofPid("p42\nf1\np42\n")).toEqual({ pid: 42 });
});
test("devices merges daemon views, resolves PID and writes snapshot", async () => {
  const f = await deviceFixture();
  expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
  const doc = document(f);
  expect(doc.devices).toHaveLength(1);
  expect(doc.devices[0]).toMatchObject({
    deviceId: "emulator-5556",
    name: "batch-avd",
    pid: 75134,
    seenByDaemons: ["P1", "P2"],
    provenance: "batch-booted",
    bootedBy: "daemon2",
    protected: false,
  });
  expect(JSON.parse(f.files.get(snapshotPath)!)).toEqual(doc);
  expect(f.captures.filter((call) => call.command === "ps")).toEqual([
    {
      command: "ps",
      args: ["eww", "-o", "command=", "-p", "75134"],
      env: expect.any(Object),
      timeoutMs: 5000,
    },
  ]);
  expect(doc.baseline).toEqual({
    recordedAt: "2026-10-13T00:00:00.000Z",
    android: "recorded",
    ios: "recorded",
  });
  expect(
    f.frames.every(
      (frame) => JSON.stringify(frame.params) === '{"name":"listDevices","arguments":{}}',
    ),
  ).toBe(true);
});
test("dead socket is reported while another daemon answers JSON text inventory", async () => {
  const f = await deviceFixture();
  f.deps.requestSocket = async (path) => {
    if (path === derivePrivateDaemonBatch(options)[0].socketPath) {
      throw new Error("dead");
    }
    return {
      success: true,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              devices: [row("sim", "sim-name", "ios"), row("physical", "phone", "android", false)],
            }),
          },
        ],
      },
    };
  };
  expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
  expect(document(f).daemons[0]).toEqual({ name: "P1", alive: false, error: "dead" });
  expect(document(f).devices.every((d: { pid: number | null }) => d.pid === null)).toBe(true);
});
test("shutdown sends one exact killDevice request to first live daemon", async () => {
  const f = await deviceFixture();
  expect(await runPrivateDaemonCommand(command("shutdown-devices"), f.deps)).toBe(0);
  expect(
    f.frames.filter((frame) => (frame.params as { name: string }).name === "killDevice"),
  ).toEqual([
    {
      path: derivePrivateDaemonBatch(options)[0].socketPath,
      method: "tools/call",
      params: {
        name: "killDevice",
        arguments: {
          device: { name: "batch-avd", deviceId: "emulator-5556", platform: "android" },
        },
      },
      timeoutMs: 60000,
    },
  ]);
  expect(document(f).results[0].outcome).toBe("stopped");
});
test.each(["emulator-5556", "batch-avd"])(
  "explicit protected target %s never gets kill frame",
  async (selector) => {
    const f = await deviceFixture(["batch-avd"]);
    expect(
      await runPrivateDaemonCommand(command("shutdown-devices", "--device", selector), f.deps),
    ).toBe(1);
    expect(document(f).results[0].outcome).toBe("protected");
    expect(f.frames).toHaveLength(2);
  },
);
test.each(["preexisting", "unknown", "physical", "empty-name"])(
  "unsafe %s target never gets kill frame",
  async (kind) => {
    const f = await deviceFixture(kind === "empty-name" ? ["protected-avd"] : []);
    f.deps.runCapture = async () => {
      throw new Error("no process evidence");
    };
    if (kind === "unknown") {
      f.files.delete(baselinePath);
    }
    f.deps.requestSocket = async () => ({
      success: true,
      result: {
        structuredContent: {
          devices: [
            row(
              kind === "preexisting" ? "preexisting" : "emulator-5556",
              kind === "empty-name" ? "" : "batch-avd",
              "android",
              kind !== "physical",
            ),
          ],
        },
      },
    });
    expect(
      await runPrivateDaemonCommand(
        command(
          "shutdown-devices",
          "--device",
          kind === "preexisting" ? "preexisting" : "emulator-5556",
        ),
        f.deps,
      ),
    ).toBe(1);
    expect(document(f).results[0].outcome).toBe(
      kind === "empty-name" ? "protected" : "not-batch-booted",
    );
  },
);
test.each(["wire", "isError", "structured", "text", "nested"])(
  "daemon refusal %s retains code and message",
  async (kind) => {
    const f = await deviceFixture();
    const list = f.deps.requestSocket;
    f.deps.requestSocket = async (path, request) => {
      if ((request.params as { name: string }).name === "listDevices") {
        return list(path, request);
      }
      const failure =
        kind === "nested"
          ? {
              success: false,
              message: "held by another daemon",
              error: { code: "HELD", message: "held by another daemon" },
            }
          : { success: false, code: "HELD", message: "held by another daemon" };
      if (kind === "wire") {
        return { success: false, code: "HELD", error: failure.message };
      }
      return {
        success: true,
        result: {
          ...(kind === "isError" || kind === "nested" ? { isError: true } : {}),
          ...(kind === "structured"
            ? { structuredContent: failure }
            : { content: [{ type: "text", text: JSON.stringify(failure) }] }),
        },
      };
    };
    expect(await runPrivateDaemonCommand(command("shutdown-devices"), f.deps)).toBe(1);
    expect(document(f).results[0]).toMatchObject({
      outcome: "refused",
      code: "HELD",
      message: "held by another daemon",
    });
  },
);
test.each(["transport failed", "request timed out"])(
  "kill rejection %s is typed",
  async (message) => {
    const f = await deviceFixture();
    const list = f.deps.requestSocket;
    f.deps.requestSocket = async (path, request) => {
      if ((request.params as { name: string }).name === "listDevices") {
        return list(path, request);
      }
      throw new Error(message);
    };
    expect(await runPrivateDaemonCommand(command("shutdown-devices"), f.deps)).toBe(1);
    expect(document(f).results[0].outcome).toBe(message.includes("timed") ? "timeout" : "failed");
  },
);
test("dry run and zero targets succeed, explicit missing target fails", async () => {
  const f = await deviceFixture();
  expect(await runPrivateDaemonCommand(command("shutdown-devices", "--dry-run"), f.deps)).toBe(0);
  expect(document(f).results[0].outcome).toBe("dry-run");
  expect(f.frames).toHaveLength(2);
  expect(
    await runPrivateDaemonCommand(command("shutdown-devices", "--device", "missing"), f.deps),
  ).toBe(1);
  expect(document(f).results[0].outcome).toBe("not-found");
  f.files.set(baselinePath, JSON.stringify({ android: ["emulator-5556"], ios: [] }));
  f.deps.runCapture = async () => {
    throw new Error("no process evidence");
  };
  expect(await runPrivateDaemonCommand(command("shutdown-devices"), f.deps)).toBe(0);
  expect(document(f).results).toEqual([]);
});
test.each(["devices", "shutdown-devices"])(
  "%s all daemons dead uses snapshot without signals",
  async (op) => {
    const f = await deviceFixture();
    expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
    f.deps.requestSocket = async () => {
      throw new Error("dead");
    };
    expect(await runPrivateDaemonCommand(command(op), f.deps)).toBe(1);
    expect(document(f).results[0]).toMatchObject({
      name: "batch-avd",
      pid: 75134,
      outcome: "daemon-dead",
      message: expect.stringContaining("protected"),
    });
  },
);
test("all daemons dead without snapshot says so", async () => {
  const f = await deviceFixture();
  f.deps.requestSocket = async () => {
    throw new Error("dead");
  };
  expect(await runPrivateDaemonCommand(command("shutdown-devices"), f.deps)).toBe(1);
  expect(document(f).message).toContain("snapshot");
});

test.each(["configured", "unavailable", "null-id", "empty-id"])(
  "%s is never listed or killed",
  async (kind) => {
    const f = await deviceFixture();
    const device = row();
    const runtime = {
      ...device.runtime,
      deviceId: kind === "null-id" ? null : kind === "empty-id" ? "" : device.runtime.deviceId,
      lifecycle: { state: ["configured", "unavailable"].includes(kind) ? kind : "booted" },
    };
    f.deps.requestSocket = async (_path, request) => {
      expect(request.params).toMatchObject({ name: "listDevices" });
      return {
        success: true,
        result: { structuredContent: { devices: [{ ...device, runtime }] } },
      };
    };
    expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
    expect(document(f).devices).toEqual([]);
    expect(await runPrivateDaemonCommand(command("shutdown-devices"), f.deps)).toBe(0);
    expect(document(f).results).toEqual([]);
  },
);
test("dead daemon fallback selects snapshot names and IDs and reports missing selectors", async () => {
  const f = await deviceFixture();
  f.deps.requestSocket = async () => ({
    success: true,
    result: {
      structuredContent: {
        devices: [row(), row("emulator-5558", "other-avd"), row("emulator-5560", "third-avd")],
      },
    },
  });
  expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
  f.deps.requestSocket = async () => {
    throw new Error("dead");
  };
  expect(
    await runPrivateDaemonCommand(
      command(
        "shutdown-devices",
        "--device",
        "batch-avd",
        "--device",
        "emulator-5560",
        "--device",
        "missing",
      ),
      f.deps,
    ),
  ).toBe(1);
  expect(
    document(f).results.map((r: { deviceId: string; outcome: string }) => [r.deviceId, r.outcome]),
  ).toEqual([
    ["missing", "not-found"],
    ["emulator-5556", "daemon-dead"],
    ["emulator-5560", "daemon-dead"],
  ]);
});

test.each(["booting", "booted", "shutting-down"])(
  "running lifecycle %s remains listed",
  async (state) => {
    const f = await deviceFixture();
    const device = row();
    f.deps.requestSocket = async () => ({
      success: true,
      result: {
        structuredContent: {
          devices: [{ ...device, runtime: { ...device.runtime, lifecycle: { state } } }],
        },
      },
    });
    expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
    expect(document(f).devices).toHaveLength(1);
  },
);

async function addBrokerLedger(f: Awaited<ReturnType<typeof deviceFixture>>) {
  const { BrokerDeviceLedger } = await import("../../scripts/manual-test/brokerDeviceLedger");
  f.files.set(join(options.batchDir, "broker/clients.json"), "{}");
  const ledger = new BrokerDeviceLedger({
    batchDir: options.batchDir,
    timer: f.deps.timer,
    fs: {
      exists: f.deps.exists,
      readFile: f.deps.readFile,
      mkdir: () => {},
      appendFile: (path, text) => f.files.set(path, (f.files.get(path) ?? "") + text),
    },
  });
  ledger.info(
    "phone",
    { session: { outcome: "ready", requestId: "batch-phone-1", sessionUuid: "session" } },
    {
      sessionId: "session",
      nativeDevice: { name: "ambroker-ledger", deviceId: "emulator-5556", platform: "android" },
    },
  );
  return ledger;
}

test.each([undefined, "broker_session", "future_hold"])(
  "broker ledger shows the client and refuses shutdown with heldBy %s",
  async (heldBy) => {
    const f = await deviceFixture();
    await addBrokerLedger(f);
    inventoryRows(f, [
      { ...row("emulator-5556", "ambroker-ledger"), runtime: { ...row().runtime, heldBy } },
    ]);
    expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
    expect(document(f).devices[0]).toMatchObject({
      classification: "allowed",
      client: "phone",
      sessionUuid: "session",
      provenance: "broker-owned",
    });
    expect(f.captures).toEqual([]);
    for (const flags of [[], ["--device", "emulator-5556"]]) {
      expect(await runPrivateDaemonCommand(command("shutdown-devices", ...flags), f.deps)).toBe(1);
      expect(document(f).results[0].outcome).toBe("broker-held");
    }
    expect(killFrames(f)).toEqual([]);
  },
);

test.each(["protected", "name-only", "serial-reused", "plain-name", "released"])(
  "broker view classifies %s conservatively",
  async (kind) => {
    const f = await deviceFixture(kind === "protected" ? ["ambroker-ledger"] : []);
    const ledger = kind === "protected" ? undefined : await addBrokerLedger(f);
    if (kind === "protected") {
      const manifestPath = join(options.batchDir, "batch.json");
      const stored = JSON.parse(f.files.get(manifestPath) ?? "{}");
      expect(
        stored.options?.protectedDevices,
        `manifest ${manifestPath} in [${[...f.files.keys()].filter((key) => key.endsWith("batch.json")).join(", ")}]: ${JSON.stringify(stored.options)}`,
      ).toEqual(["ambroker-ledger"]);
      await expect(addBrokerLedger(f)).rejects.toBeInstanceOf(BrokerDeviceInfoRefusedError);
    }
    const name =
      kind === "name-only"
        ? "ambroker-unrecorded"
        : kind === "serial-reused"
          ? "ambroker-successor"
          : kind === "plain-name"
            ? "owner-device"
            : "ambroker-ledger";
    if (kind === "released") {
      ledger!.record("released", ledger!.devices()[0]);
    }
    inventoryRows(f, [row("emulator-5556", name)]);
    expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
    expect(document(f).devices[0].classification).toBe(
      kind === "protected" ? "protected" : "foreign",
    );
    expect(document(f).devices[0].client).toBeUndefined();
    expect(
      await runPrivateDaemonCommand(
        command("shutdown-devices", "--device", "emulator-5556"),
        f.deps,
      ),
    ).toBe(1);
    expect(killFrames(f)).toEqual([]);
  },
);

test("devices --ledger reads evidence with no socket, host probe or write", async () => {
  const f = await deviceFixture();
  const ledger = await addBrokerLedger(f);
  const writes = f.writes.length;
  expect(await runPrivateDaemonCommand(command("devices", "--ledger"), f.deps)).toBe(0);
  expect(document(f).ledger).toEqual(ledger.entries);
  expect(f.frames).toEqual([]);
  expect(f.captures).toEqual([]);
  expect(f.writes.length).toBe(writes);
});

test("protection wins over conflicting broker inventory identities", async () => {
  const f = await deviceFixture(["protected-name"]);
  await addBrokerLedger(f);
  inventoryRows(f, [
    row("emulator-5556", "ambroker-ledger"),
    row("emulator-5556", "protected-name"),
  ]);
  expect(await runPrivateDaemonCommand(command("devices"), f.deps)).toBe(0);
  expect(document(f).devices[0]).toMatchObject({ classification: "protected", protected: true });
  expect(
    await runPrivateDaemonCommand(command("shutdown-devices", "--device", "emulator-5556"), f.deps),
  ).toBe(1);
  expect(document(f).results[0].outcome).toBe("protected");
  expect(killFrames(f)).toEqual([]);
});
