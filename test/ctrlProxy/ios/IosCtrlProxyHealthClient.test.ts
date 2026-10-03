import { describe, expect, spyOn, test } from "bun:test";
import {
  IosCtrlProxyHealthClient,
  isValidCtrlProxyPort,
  type CtrlProxyHealthContext,
} from "../../../src/ctrlProxy/ios/IosCtrlProxyHealthClient";
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
): { client: IosCtrlProxyHealthClient; executor: FakeProcessExecutor } {
  const executor = new FakeProcessExecutor();
  executor.setCommandHandler("curl", handler);
  const client = new IosCtrlProxyHealthClient(executor, new FakeTimer(), context);
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

describe("IosCtrlProxyHealthClient (local curl transport)", function () {
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

  test("typed health check distinguishes refused, reset, and timeout while boolean stays false", async function () {
    for (const [error, reason] of [
      [Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }), "refused"],
      [Object.assign(new Error("socket closed"), { code: "ECONNRESET" }), "reset"],
      [Object.assign(new Error("aborted"), { name: "AbortError" }), "timeout"],
    ] as const) {
      const { client } = makeClient(() => {
        throw error;
      });
      expect(await client.checkHealthEndpointOnPortWithReason(8765)).toEqual({ ok: false, reason });
      expect(await client.checkHealthEndpointOnPort(8765)).toBe(false);
    }
  });

  test("checkHealthEndpointOnPortForDevice requires a matching device id", async function () {
    const matching = makeClient(() => execResult(`{"status":"ok","deviceId":"${DEVICE_ID}"}`));
    expect(await matching.client.checkHealthEndpointOnPortForDevice(8765, DEVICE_ID)).toBe(true);

    const foreign = makeClient(() => execResult('{"status":"ok","deviceId":"OTHER"}'));
    expect(await foreign.client.checkHealthEndpointOnPortForDevice(8765, DEVICE_ID)).toBe(false);
  });

  test("device-aware typed health distinguishes transport failure from unhealthy identity", async function () {
    for (const [error, reason] of [
      [Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }), "refused"],
      [Object.assign(new Error("socket closed"), { code: "ECONNRESET" }), "reset"],
      [Object.assign(new Error("aborted"), { name: "AbortError" }), "timeout"],
    ] as const) {
      const { client } = makeClient(() => {
        throw error;
      });
      expect(await client.checkHealthEndpointOnPortForDeviceWithReason(8765, DEVICE_ID)).toEqual({
        ok: false,
        reason,
      });
      expect(await client.checkHealthEndpointOnPortForDevice(8765, DEVICE_ID)).toBe(false);
    }
    const wrongDevice = makeClient(() => execResult('{"status":"ok","deviceId":"OTHER"}'));
    expect(
      await wrongDevice.client.checkHealthEndpointOnPortForDeviceWithReason(8765, DEVICE_ID),
    ).toEqual({ ok: false, reason: "unhealthy" });
    const matching = makeClient(() => execResult(`{"status":"ok","deviceId":"${DEVICE_ID}"}`));
    expect(
      await matching.client.checkHealthEndpointOnPortForDeviceWithReason(8765, DEVICE_ID),
    ).toEqual({ ok: true });
  });

  test("checkHealthEndpointOnPortForDevice rejects a non-JSON (Android 'OK') body", async function () {
    const { client } = makeClient(() => execResult("OK"));
    expect(await client.checkHealthEndpointOnPortForDevice(8765, DEVICE_ID)).toBe(false);
  });

  // #6415: compat mode can accept a runner build that reports no deviceId
  // (older build or env-injection fallback), while the default liveness check
  // requires an exact deviceId match.
  test("checkHealthEndpointOnPortForDevice accepts an 'ok' body reporting no deviceId (compat)", async function () {
    const { client } = makeClient(() => execResult('{"status":"ok"}'));
    expect(await client.checkHealthEndpointOnPortForDevice(8765, DEVICE_ID)).toBe(false);
    expect(
      await client.checkHealthEndpointOnPortForDevice(8765, DEVICE_ID, undefined, {
        requireDeviceId: false,
      }),
    ).toBe(true);
  });

  // #6415 follow-up: ownership/forced-teardown decisions explicitly require
  // device identity, matching the strict default used by the liveness gate.
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

  test("threads doctor cancellation and timeout into the local transport", async () => {
    const executor = new FakeProcessExecutor();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    let transportSignal: AbortSignal | undefined;
    const execute = spyOn(executor, "executeCommand").mockImplementation(
      async (_file, args, options) => {
        expect(args).toContain("0.05");
        expect(options?.timeoutMs).toBe(50);
        transportSignal = options?.signal;
        started.resolve();
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    );
    const client = new IosCtrlProxyHealthClient(executor, new FakeTimer(), localContext());
    const health = client.checkHealthEndpointOnPortForDevice(8768, DEVICE_ID, 50, {
      signal: controller.signal,
    });
    await started.promise;
    controller.abort(new Error("doctor cancelled"));
    await expect(health).rejects.toThrow("doctor cancelled");
    expect(transportSignal).toBe(controller.signal);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("does not start a transport probe after cancellation", async () => {
    const { client, executor } = makeClient(() => execResult("OK"));
    const execute = spyOn(executor, "executeCommand");
    const controller = new AbortController();
    controller.abort(new Error("doctor cancelled"));
    await expect(
      client.checkHealthEndpointOnPortForDevice(8768, DEVICE_ID, 50, {
        signal: controller.signal,
      }),
    ).rejects.toThrow("doctor cancelled");
    expect(execute).not.toHaveBeenCalled();
  });

  test("probes IPv4 loopback on the requested port via curl", async function () {
    const commands: string[] = [];
    const { client } = makeClient((command) => {
      commands.push(command);
      return execResult('{"status":"ok"}');
    });
    await client.checkHealthEndpointOnPort(9999);
    expect(commands.some((c) => c.includes("http://127.0.0.1:9999/health"))).toBe(true);
  });
});
