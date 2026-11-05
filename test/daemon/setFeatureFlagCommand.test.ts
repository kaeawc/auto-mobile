import { describe, expect, spyOn, test } from "bun:test";
import {
  daemonCommandArgumentError,
  runDaemonCommand,
} from "../../src/daemon/cli/runDaemonCommand";
import {
  SET_FEATURE_FLAG_METHOD,
  parseSetFeatureFlagArgs,
} from "../../src/daemon/cli/featureFlagCommand";
import type { DaemonStateLike } from "../../src/daemon/daemonState";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";

const unexpected = (): never => {
  throw new Error("Unexpected local daemon access");
};
const remoteState: DaemonStateLike = {
  isInitialized: () => false,
  getSessionManager: unexpected,
  getDevicePool: unexpected,
  getDeviceSessionRegistry: unexpected,
};

async function run(args: string[], client: FakeDaemonClient) {
  const output: Array<[string, unknown]> = [];
  const exited = new Error("fake exit");
  const log = spyOn(console, "log").mockImplementation((text) => output.push(["stdout", text]));
  const error = spyOn(console, "error").mockImplementation((text) => output.push(["stderr", text]));
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    output.push(["exit", code]);
    throw exited;
  });
  try {
    await runDaemonCommand(
      "set-feature-flag",
      args,
      { clientFactory: () => client, stateProvider: () => remoteState },
      SafeDaemonManager,
    ).catch((caught: unknown) => {
      if (caught !== exited) {
        throw caught;
      }
    });
  } finally {
    exit.mockRestore();
    error.mockRestore();
    log.mockRestore();
  }
  return output;
}

// #16882: an agent without the IDE plugin had no way to turn on the device-condition flag.
describe("--daemon set-feature-flag", () => {
  test("sets the flag through the daemon route the IDE plugin uses", async () => {
    const client = new FakeDaemonClient({
      onCallDaemonMethod: (method, params) =>
        method === SET_FEATURE_FLAG_METHOD
          ? { key: params.key, enabled: params.enabled }
          : undefined,
    });
    const output = await run(["device-condition", "true"], client);
    expect(client.callDaemonMethodCalls).toEqual([
      { method: SET_FEATURE_FLAG_METHOD, params: { key: "device-condition", enabled: true } },
    ]);
    expect(output).toEqual([["stdout", "Feature flag device-condition is now enabled"]]);
  });

  test("--json prints the daemon's flag state", async () => {
    const client = new FakeDaemonClient({
      onCallDaemonMethod: () => ({ key: "device-condition", enabled: false }),
    });
    const output = await run(["device-condition", "false", "--json"], client);
    expect(output).toEqual([
      ["stdout", JSON.stringify({ ok: true, flag: { key: "device-condition", enabled: false } })],
    ]);
  });

  test("an unknown key is refused before any daemon call and names the known keys", async () => {
    const client = new FakeDaemonClient({});
    const output = await run(["no-such-flag", "true"], client);
    expect(client.callDaemonMethodCalls).toEqual([]);
    expect(String(output[0]?.[1])).toContain("Known flags:");
    expect(String(output[0]?.[1])).toContain("device-condition");
    expect(output).toContainEqual(["exit", 1]);
  });

  test.each([[["device-condition"]], [["device-condition", "yes"]]])(
    "%j is refused with a usage error",
    (args) => {
      expect(() => parseSetFeatureFlagArgs(args)).toThrow();
    },
  );

  test("takes exactly two positional words", () => {
    expect(
      daemonCommandArgumentError("set-feature-flag", ["device-condition", "true"]),
    ).toBeUndefined();
    expect(
      daemonCommandArgumentError("set-feature-flag", ["device-condition", "true", "extra"]),
    ).toBeDefined();
    expect(
      daemonCommandArgumentError("set-feature-flag", ["device-condition", "--jsno"]),
    ).toBeDefined();
  });
});
