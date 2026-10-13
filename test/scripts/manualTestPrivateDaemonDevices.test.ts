import { expect, test } from "bun:test";
import { z } from "zod";
import { join } from "node:path";
import { fixture, options, parsed } from "./manualTestPrivateDaemon.test";
import { runPrivateDaemonCommand } from "../../scripts/manual-test/private-daemon";
import { derivePrivateDaemonBatch } from "../../scripts/manual-test/privateDaemonEnv";
// Load the captured fixture as a text asset; command tests never use host filesystem APIs.
const capture: { default: unknown } = await import(
  new URL("../fixtures/manual-test-host/lsof-console-port-listener.txt", import.meta.url).href,
  { with: { type: "text" } }
);
const lsofCapture = z.string().parse(capture.default);
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
    runtime: { deviceId: id, poolStatus: "idle", heldBy: undefined },
  };
}
async function deviceFixture(protectedDevices: string[] = []) {
  const f = fixture();
  await runPrivateDaemonCommand(
    {
      op: "init",
      options: { ...options, ...(protectedDevices.length ? { protectedDevices } : {}) },
    },
    f.deps,
  );
  f.files.set(
    baselinePath,
    JSON.stringify({ recordedAt: "2026-10-13T00:00:00.000Z", android: ["preexisting"], ios: [] }),
  );
  const frames: Array<{ path: string; method: string; params?: unknown; timeoutMs: number }> = [];
  f.deps.runCapture = async () => ({ exitCode: 0, stdout: lsofCapture, stderr: "" });
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
      provenance: "batch-booted",
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
    protected: false,
  });
  expect(JSON.parse(f.files.get(snapshotPath)!)).toEqual(doc);
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
