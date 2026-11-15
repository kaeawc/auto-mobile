import { describe, expect, test } from "bun:test";
import type { DeviceStreamingConfig } from "../../../src/devices/remote/deviceStreaming/deviceStreamingConfig";
import type {
  RemoteAdbConnection,
  RemoteAdbTransport,
  RemoteDeviceConnectSetup,
  RemoteDeviceIdentity,
} from "../../../src/devices/remote/remoteDeviceAcquisition";
import { createRemoteDeviceAcquisitionFromEnv } from "../../../src/devices/remote/remoteDeviceAcquisitionFactory";
import type { RemoteDeviceSession } from "../../../src/devices/remote/remoteDeviceProvider";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeRemoteDeviceProvider } from "../../fakes/FakeRemoteDeviceProvider";
import { FakeTimer } from "../../fakes/FakeTimer";

const OPTED_IN = {
  AUTOMOBILE_DEVICE_STREAMING: "true",
  AUTOMOBILE_DEVICE_STREAMING_PROJECT: "my-project-1",
};

class LoopbackTransport implements RemoteAdbTransport {
  readonly closed: string[] = [];

  async connect(session: RemoteDeviceSession): Promise<RemoteAdbConnection> {
    const serial = `127.0.0.1:${session.id.length}`;
    return { serial, close: async () => void this.closed.push(serial) };
  }
}

class RecordingSetup implements RemoteDeviceConnectSetup {
  readonly installs: string[] = [];

  async installCtrlProxy(serial: string): Promise<void> {
    this.installs.push(serial);
  }

  async readIdentity(): Promise<RemoteDeviceIdentity> {
    return { manufacturer: "Google", brand: "google", model: "Pixel 8" };
  }
}

function build(env: NodeJS.ProcessEnv) {
  const provider = new FakeRemoteDeviceProvider();
  const transport = new LoopbackTransport();
  const setup = new RecordingSetup();
  const configs: DeviceStreamingConfig[] = [];
  const create = () =>
    createRemoteDeviceAcquisitionFromEnv({
      host: new FakeHostCommandExecutor(),
      timer: new FakeTimer(),
      transport,
      setup,
      env,
      createProvider: (config) => {
        configs.push(config);
        return provider;
      },
    });
  return { provider, transport, setup, configs, create };
}

describe("createRemoteDeviceAcquisitionFromEnv", () => {
  test("builds nothing without the opt-in", () => {
    const { create, configs } = build({ AUTOMOBILE_DEVICE_STREAMING_PROJECT: "my-project-1" });

    expect(create()).toBeUndefined();
    expect(configs).toEqual([]);
  });

  test("an opted-in config without a project id names the missing setting", () => {
    const { create, configs } = build({ AUTOMOBILE_DEVICE_STREAMING: "1" });

    expect(create).toThrow("needs the Google Cloud project id");
    expect(configs).toEqual([]);
  });

  test("a malformed cap is refused before any provider is built", () => {
    const { create, configs } = build({
      ...OPTED_IN,
      AUTOMOBILE_DEVICE_STREAMING_MAX_SESSION_MINUTES: "0",
    });

    expect(create).toThrow("positive whole number of minutes");
    expect(configs).toEqual([]);
  });

  test("an opted-in config acquires through the provider and releases on releaseAll", async () => {
    const { create, configs, provider, transport, setup } = build(OPTED_IN);
    const acquisition = create();
    if (!acquisition) {
      throw new Error("expected an acquisition");
    }

    const lease = await acquisition.acquire({ modelId: "shiba", osVersionId: "34", minutes: 10 });

    expect(configs).toEqual([
      { optIn: true, projectId: "my-project-1", maxSessionMinutes: undefined },
    ]);
    expect(setup.installs).toEqual([lease.serial]);
    expect(acquisition.summarize(lease)).toMatchObject({
      manufacturer: "Google",
      remainingMinutes: 10,
    });
    expect(await acquisition.releaseAll()).toEqual([]);
    expect(provider.released).toEqual([lease.sessionId]);
    expect(transport.closed).toEqual([lease.serial]);
  });
});
