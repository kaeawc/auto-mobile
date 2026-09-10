import { describe, expect, test } from "bun:test";
import {
  IOSCtrlProxyHealthClient,
  isValidCtrlProxyPort,
  type CtrlProxyHealthContext,
} from "../../../src/utils/ios/IOSCtrlProxyHealthClient";
import { FakeProcessExecutor } from "../../fakes/FakeProcessExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { ExecResult } from "../../../src/models";

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (searchString: string) => stdout.includes(searchString),
  };
}

const DEVICE_ID = "SIM-DEVICE-1";

function localContext(): CtrlProxyHealthContext {
  return {
    useRemoteRunner: () => false,
    getHost: () => "unused.local",
    deviceId: DEVICE_ID,
  };
}

function makeClient(
  handler: (command: string) => ExecResult,
  context: CtrlProxyHealthContext = localContext(),
): { client: IOSCtrlProxyHealthClient; executor: FakeProcessExecutor } {
  const executor = new FakeProcessExecutor();
  executor.setCommandHandler("curl", handler);
  const client = new IOSCtrlProxyHealthClient(executor, new FakeTimer(), context);
  return { client, executor };
}

describe("isValidCtrlProxyPort", function () {
  test("accepts an in-range integer port", function () {
    expect(isValidCtrlProxyPort(8765)).toBe(true);
    expect(isValidCtrlProxyPort(1)).toBe(true);
    expect(isValidCtrlProxyPort(65535)).toBe(true);
  });

  test("rejects out-of-range, non-integer, and non-number values", function () {
    expect(isValidCtrlProxyPort(0)).toBe(false);
    expect(isValidCtrlProxyPort(65536)).toBe(false);
    expect(isValidCtrlProxyPort(80.5)).toBe(false);
    expect(isValidCtrlProxyPort("8765")).toBe(false);
    expect(isValidCtrlProxyPort(undefined)).toBe(false);
  });
});

describe("IOSCtrlProxyHealthClient (local curl transport)", function () {
  test("checkHealthEndpointOnPort is true for an 'ok'/'healthy' body", async function () {
    const { client } = makeClient(() => execResult('{"status":"ok"}'));
    expect(await client.checkHealthEndpointOnPort(8765)).toBe(true);
  });

  test("checkHealthEndpointOnPort is false when the runner does not answer", async function () {
    const { client } = makeClient(() => {
      throw new Error("connection refused");
    });
    expect(await client.checkHealthEndpointOnPort(8765)).toBe(false);
  });

  test("checkHealthEndpointOnPortForDevice requires a matching device id", async function () {
    const matching = makeClient(() => execResult(`{"status":"ok","deviceId":"${DEVICE_ID}"}`));
    expect(await matching.client.checkHealthEndpointOnPortForDevice(8765, DEVICE_ID)).toBe(true);

    const foreign = makeClient(() => execResult('{"status":"ok","deviceId":"OTHER"}'));
    expect(await foreign.client.checkHealthEndpointOnPortForDevice(8765, DEVICE_ID)).toBe(false);
  });

  test("checkHealthEndpointOnPortForDevice rejects a non-JSON (Android 'OK') body", async function () {
    const { client } = makeClient(() => execResult("OK"));
    expect(await client.checkHealthEndpointOnPortForDevice(8765, DEVICE_ID)).toBe(false);
  });

  // #6415: a runner build that reports no deviceId at all (older build, or the
  // env-injection fallback that also drops the device-id var) must still count
  // as "ours" when status is ok — only a PRESENT-but-different deviceId is a
  // foreign runner. Without this compat carve-out, checkHealthEndpoint() could
  // never route through the strict check without regressing older runners.
  test("checkHealthEndpointOnPortForDevice accepts an 'ok' body reporting no deviceId (compat)", async function () {
    const { client } = makeClient(() => execResult('{"status":"ok"}'));
    expect(await client.checkHealthEndpointOnPortForDevice(8765, DEVICE_ID)).toBe(true);
  });

  // #6415 follow-up: ownership/forced-teardown decisions must fail closed on a
  // missing deviceId — the compat carve-out above is for the liveness gate only.
  describe("checkHealthEndpointOnPortForDevice with requireDeviceId (strict ownership gate)", function () {
    test("rejects an 'ok' body reporting no deviceId", async function () {
      const { client } = makeClient(() => execResult('{"status":"ok"}'));
      expect(
        await client.checkHealthEndpointOnPortForDevice(8765, DEVICE_ID, undefined, {
          requireDeviceId: true,
        }),
      ).toBe(false);
    });

    test("rejects a mismatched deviceId", async function () {
      const { client } = makeClient(() => execResult('{"status":"ok","deviceId":"OTHER"}'));
      expect(
        await client.checkHealthEndpointOnPortForDevice(8765, DEVICE_ID, undefined, {
          requireDeviceId: true,
        }),
      ).toBe(false);
    });

    test("accepts a matching deviceId", async function () {
      const { client } = makeClient(() => execResult(`{"status":"ok","deviceId":"${DEVICE_ID}"}`));
      expect(
        await client.checkHealthEndpointOnPortForDevice(8765, DEVICE_ID, undefined, {
          requireDeviceId: true,
        }),
      ).toBe(true);
    });
  });

  test("readReportedPortFromHealth returns the self-reported port for our device", async function () {
    const { client } = makeClient(() =>
      execResult(`{"status":"ok","deviceId":"${DEVICE_ID}","port":9100}`),
    );
    expect(await client.readReportedPortFromHealth(8765)).toBe(9100);
  });

  test("readReportedPortFromHealth rejects a runner for a different device", async function () {
    const { client } = makeClient(() =>
      execResult('{"status":"ok","deviceId":"OTHER","port":9100}'),
    );
    expect(await client.readReportedPortFromHealth(8765)).toBeNull();
  });

  test("readReportedPortFromHealth rejects a non-ok status or invalid port", async function () {
    const notOk = makeClient(() =>
      execResult(`{"status":"starting","deviceId":"${DEVICE_ID}","port":9100}`),
    );
    expect(await notOk.client.readReportedPortFromHealth(8765)).toBeNull();

    const badPort = makeClient(() =>
      execResult(`{"status":"ok","deviceId":"${DEVICE_ID}","port":70000}`),
    );
    expect(await badPort.client.readReportedPortFromHealth(8765)).toBeNull();
  });

  test("probes localhost on the requested port via curl", async function () {
    const commands: string[] = [];
    const { client } = makeClient((command) => {
      commands.push(command);
      return execResult('{"status":"ok"}');
    });
    await client.checkHealthEndpointOnPort(9999);
    expect(commands.some((c) => c.includes("http://localhost:9999/health"))).toBe(true);
  });
});
