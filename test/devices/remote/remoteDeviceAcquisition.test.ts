import { describe, expect, test } from "bun:test";
import {
  RemoteDeviceAcquisition,
  type RemoteAdbConnection,
  type RemoteAdbTransport,
  type RemoteDeviceConnectSetup,
  type RemoteDeviceIdentity,
} from "../../../src/devices/remote/remoteDeviceAcquisition";
import type { RemoteDeviceSession } from "../../../src/devices/remote/remoteDeviceProvider";
import { FakeRemoteDeviceProvider } from "../../fakes/FakeRemoteDeviceProvider";
import { FakeTimer } from "../../fakes/FakeTimer";

const MINUTE_MS = 60_000;
const request = { modelId: "a54x", osVersionId: "34", minutes: 20 };

class FakeTransport implements RemoteAdbTransport {
  readonly connected: string[] = [];
  readonly closed: string[] = [];
  connectError?: Error;
  closeError?: Error;

  async connect(session: RemoteDeviceSession): Promise<RemoteAdbConnection> {
    if (this.connectError) {
      throw this.connectError;
    }
    this.connected.push(session.id);
    const serial = `127.0.0.1:${5000 + this.connected.length}`;
    return {
      serial,
      close: async () => {
        this.closed.push(serial);
        if (this.closeError) {
          throw this.closeError;
        }
      },
    };
  }
}

class FakeSetup implements RemoteDeviceConnectSetup {
  readonly installs: string[] = [];
  installError?: Error;
  identity: RemoteDeviceIdentity | Error = {
    manufacturer: "samsung",
    brand: "samsung",
    model: "SM-A546E",
  };

  async installCtrlProxy(serial: string): Promise<void> {
    this.installs.push(serial);
    if (this.installError) {
      throw this.installError;
    }
  }

  async readIdentity(): Promise<RemoteDeviceIdentity> {
    if (this.identity instanceof Error) {
      throw this.identity;
    }
    return this.identity;
  }
}

function setup() {
  const provider = new FakeRemoteDeviceProvider();
  const transport = new FakeTransport();
  const connectSetup = new FakeSetup();
  const timer = new FakeTimer();
  const acquisition = new RemoteDeviceAcquisition({
    provider,
    transport,
    setup: connectSetup,
    timer,
  });
  return { provider, transport, connectSetup, timer, acquisition };
}

describe("RemoteDeviceAcquisition.acquire", () => {
  test("reserves, connects adb, reinstalls CtrlProxy and reads the device identity", async () => {
    const { provider, transport, connectSetup, acquisition } = setup();

    const lease = await acquisition.acquire(request);

    expect(provider.reserved).toEqual([request]);
    expect(transport.connected).toEqual(["fake-session-1"]);
    expect(connectSetup.installs).toEqual(["127.0.0.1:5001"]);
    expect(lease).toEqual({
      sessionId: "fake-session-1",
      serial: "127.0.0.1:5001",
      identity: { manufacturer: "samsung", brand: "samsung", model: "SM-A546E" },
      cost: { minutes: 20, usdPerMinute: 0.15, maxUsd: 3, freeMinutesPerProjectPerMonth: 30 },
      expireTimeMs: 20 * MINUTE_MS,
    });
    expect(acquisition.heldSessionIds()).toEqual(["fake-session-1"]);
  });

  test("an unreadable identity leaves it unknown instead of failing the device", async () => {
    const { connectSetup, acquisition } = setup();
    connectSetup.identity = new Error("getprop timed out");

    const lease = await acquisition.acquire(request);

    expect(lease.identity).toEqual({ manufacturer: null, brand: null, model: null });
  });

  test("a failed adb connect releases the session and rethrows", async () => {
    const { provider, transport, acquisition } = setup();
    transport.connectError = new Error("AdbConnect stream refused");

    await expect(acquisition.acquire(request)).rejects.toThrow("AdbConnect stream refused");

    expect(provider.released).toEqual(["fake-session-1"]);
    expect(acquisition.heldSessionIds()).toEqual([]);
  });

  test("a failed CtrlProxy install disconnects adb and releases the session", async () => {
    const { provider, transport, connectSetup, acquisition } = setup();
    connectSetup.installError = new Error("install failed");

    await expect(acquisition.acquire(request)).rejects.toThrow("install failed");

    expect(transport.closed).toEqual(["127.0.0.1:5001"]);
    expect(provider.released).toEqual(["fake-session-1"]);
  });

  test("a release that also fails tells the caller the session may still be billing", async () => {
    const { provider, connectSetup, acquisition } = setup();
    connectSetup.installError = new Error("install failed");
    provider.releaseError = new Error("HTTP 503");

    await expect(acquisition.acquire(request)).rejects.toThrow(
      "install failed. Releasing remote session fake-session-1 also failed (HTTP 503); " +
        "cancel it in the Google Cloud console so it stops billing.",
    );
  });
});

describe("RemoteDeviceAcquisition.release", () => {
  test("disconnects adb and ends the session", async () => {
    const { provider, transport, acquisition } = setup();
    await acquisition.acquire(request);

    await acquisition.release("fake-session-1");

    expect(transport.closed).toEqual(["127.0.0.1:5001"]);
    expect(provider.released).toEqual(["fake-session-1"]);
    expect(acquisition.heldSessionIds()).toEqual([]);
  });

  test("a failed adb close still ends the session", async () => {
    const { provider, transport, acquisition } = setup();
    await acquisition.acquire(request);
    transport.closeError = new Error("already gone");

    await acquisition.release("fake-session-1");

    expect(provider.released).toEqual(["fake-session-1"]);
  });

  test("releaseAll ends every session, keeps the ones that failed, and returns their ids", async () => {
    const { provider, acquisition } = setup();
    await acquisition.acquire(request);
    await acquisition.acquire(request);
    provider.releaseError = new Error("HTTP 503");

    expect(await acquisition.releaseAll()).toEqual(["fake-session-1", "fake-session-2"]);
    expect(acquisition.heldSessionIds()).toEqual(["fake-session-1", "fake-session-2"]);

    provider.releaseError = undefined;
    expect(await acquisition.releaseAll()).toEqual([]);
    expect(acquisition.heldSessionIds()).toEqual([]);
  });
});

describe("RemoteDeviceAcquisition.summarize", () => {
  test("reports the cost and whole minutes left", async () => {
    const { timer, acquisition } = setup();
    const lease = await acquisition.acquire(request);
    timer.setCurrentTime(5 * MINUTE_MS + 30_000);

    expect(acquisition.summarize(lease)).toEqual({
      sessionId: "fake-session-1",
      serial: "127.0.0.1:5001",
      manufacturer: "samsung",
      brand: "samsung",
      model: "SM-A546E",
      cost: { minutes: 20, usdPerMinute: 0.15, maxUsd: 3, freeMinutesPerProjectPerMonth: 30 },
      remainingMinutes: 14,
    });
  });

  test("omits the remaining time when the provider gave no end time", async () => {
    const { acquisition } = setup();
    const lease = await acquisition.acquire(request);

    expect(acquisition.summarize({ ...lease, expireTimeMs: undefined }).remainingMinutes).toBe(
      undefined,
    );
  });
});
