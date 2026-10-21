import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createExecResult } from "../../src/utils/execResult";
import { InMemoryControlSocket, RawFrameClient } from "../helpers/inMemoryDaemonWire";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import {
  transportAliasHarness,
  booted,
  USB,
  WIRELESS,
  EMULATOR,
  HOLDER,
  type HarnessOptions,
} from "../helpers/transportAliasHarness";
import { spyOnIosClientFactory } from "../helpers/iosCtrlProxyClientSpies";

interface Scenario extends HarnessOptions {
  name: string;
  target: string;
  platform?: "android" | "ios";
  requester?: string;
  expected: string;
  /** Switch discovery to a newly connected, probe-proven remote emulator after USB is held. */
  remote?: boolean;
  heldUnrepresentedEmulator?: boolean;
}
const generic = "0123456789abcdef";
const owned = "device_owned_by_other_session";
const scenarios: Scenario[] = [
  {
    name: "folded held alias, sessionless",
    pooledRows: [booted(USB), booted(WIRELESS)],
    held: USB,
    target: WIRELESS,
    expected: owned,
  },
  {
    name: "folded held alias, holder",
    pooledRows: [booted(USB), booted(WIRELESS)],
    held: USB,
    target: WIRELESS,
    requester: HOLDER,
    expected: "ran",
  },
  {
    name: "generic identity, sessionless",
    pooledRows: [booted(generic), booted(WIRELESS)],
    held: generic,
    serial: generic,
    target: WIRELESS,
    expected: owned,
  },
  {
    name: "generic identity, other session",
    pooledRows: [booted(generic), booted(WIRELESS)],
    held: generic,
    serial: generic,
    target: WIRELESS,
    requester: "stranger-session",
    expected: owned,
  },
  {
    name: "generic identity, holder keeps the untyped refusal",
    pooledRows: [booted(generic), booted(WIRELESS)],
    held: generic,
    serial: generic,
    target: WIRELESS,
    requester: HOLDER,
    expected: "unproven",
  },
  {
    name: "generic identity, nothing held",
    pooledRows: [booted(WIRELESS)],
    serial: generic,
    target: WIRELESS,
    expected: "ran",
  },
  {
    name: "probe-proven remote emulator vs physical holder",
    pooledRows: [booted(USB)],
    held: USB,
    remote: true,
    target: "10.0.0.7:5555",
    expected: "ran",
  },
  {
    name: "loopback port vs a different held emulator",
    pooledRows: [],
    heldUnrepresentedEmulator: true,
    target: "localhost:5557",
    expected: "ran",
  },
  {
    name: "generic identity vs unrepresented managed hold",
    pooledRows: [booted(WIRELESS)],
    serial: generic,
    bindingStableId: "Absent-Phone",
    target: WIRELESS,
    expected: "device_assigned_to_binding",
  },
  {
    name: "wireless-shaped iOS id vs Android holder",
    pooledRows: [booted(USB)],
    held: USB,
    iosRows: [{ deviceId: WIRELESS, name: "iPhone", platform: "ios" }],
    platform: "ios",
    target: WIRELESS,
    expected: "ran",
  },
];
// Codes are compared verbatim; the shared untyped refusal has each path's action prefix.
function verdict(outcome: string | undefined): string | undefined {
  return outcome?.includes("has no proven identity") ? "unproven" : outcome;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

async function runScenario(scenario: Scenario, cleanups: Array<() => void>) {
  const h = await transportAliasHarness(scenario, cleanups);
  if (scenario.requester === "stranger-session") {
    await h.sessions.createSession("stranger-session", "OTHER-DEVICE", "android");
  }
  if (scenario.heldUnrepresentedEmulator) {
    await h.sessions.createSession(HOLDER, EMULATOR, "android");
    h.adb.setCommandError("getprop ro.serialno", new Error("unreadable"));
    h.connect([booted(scenario.target)]);
  }
  if (scenario.remote) {
    h.adb.setCommandResponse("getprop ro.kernel.qemu", createExecResult("1", ""));
    h.adb.setCommandResponse("getprop ro.boot.qemu.avd_name", createExecResult("Pixel", ""));
    h.connect([booted(scenario.target)]);
  }
  const ios = spyOnIosClientFactory(() => ({
    bindSession: () => undefined,
    getScreenScaleMetadata: () => ({ nativeScale: 1, pixelWidth: 100, pixelHeight: 100 }),
    requestTapCoordinates: async () => ({ success: true }),
  }));
  cleanups.push(() => ios.mockRestore());
  const wire = InMemoryControlSocket.attach({
    timer: h.timer,
    connectionIds: new FakeIdGenerator(),
    loopback: async () => {
      throw new Error("Parity harness must not forward MCP calls");
    },
    startupOptions: {
      sessionToolSelectionService: { isEnabled: async () => true, setEnabled: async () => {} },
    },
  });
  const client = new RawFrameClient("parity", () => wire.connect("parity-connection"));
  cleanups.push(() => {
    client.close();
    wire.kill();
  });
  const args = {
    platform: scenario.platform ?? "android",
    deviceId: scenario.target,
    sessionUuid: scenario.requester,
  };
  const frame = await client.request("input/tap", { ...args, x: 1, y: 2 });
  const frameVerdict = verdict(
    frame.success
      ? "ran"
      : typeof frame.code === "number"
        ? String(frame.code)
        : (frame.code ?? frame.error),
  );
  const toolVerdict = verdict(await h.outcome("controlProbe", args));
  return { frame: frameVerdict, tool: toolVerdict };
}

// Pay first-use module/JIT warm-up only, outside the measured tests.
// Each scenario builds its own fixture, including the throwaway warm-up.
beforeAll(async () => {
  const warmUpCleanups: Array<() => void> = [];
  try {
    await runScenario(scenarios[0]!, warmUpCleanups);
  } finally {
    for (const cleanup of warmUpCleanups.reverse()) {
      cleanup();
    }
  }
});

describe.each(scenarios)("direct frames and tools agree: $name", (scenario) => {
  test("both paths return the expected verdict", async () => {
    const result = await runScenario(scenario, cleanups);
    expect(result).toEqual({
      frame: scenario.expected,
      tool: scenario.expected,
    });
    expect(result.tool).toBe(result.frame);
  });
});
