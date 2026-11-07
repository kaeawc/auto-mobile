import { describe, expect, test } from "bun:test";
import {
  createDeviceStreamingProvider,
  DEFAULT_MAX_SESSION_MINUTES,
  resolveDeviceStreamingConfig,
} from "../../../../src/devices/remote/deviceStreaming/deviceStreamingConfig";
import { DeviceStreamingRemoteDeviceProvider } from "../../../../src/devices/remote/deviceStreaming/DeviceStreamingRemoteDeviceProvider";
import { FakeHostCommandExecutor } from "../../../fakes/FakeHostCommandExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

describe("resolveDeviceStreamingConfig", () => {
  test("an opted-in config gets the default cap when none is given", () => {
    expect(resolveDeviceStreamingConfig({ optIn: true, projectId: " my-project-1 " })).toEqual({
      projectId: "my-project-1",
      guards: { optIn: true, maxSessionMinutes: DEFAULT_MAX_SESSION_MINUTES },
    });
  });

  test("accepts a domain-scoped project id and an explicit cap", () => {
    expect(
      resolveDeviceStreamingConfig({
        optIn: true,
        projectId: "example.com:lab-devices",
        maxSessionMinutes: 90,
      }),
    ).toEqual({
      projectId: "example.com:lab-devices",
      guards: { optIn: true, maxSessionMinutes: 90 },
    });
  });

  test("refuses to build anything without an explicit opt-in", () => {
    expect(() => resolveDeviceStreamingConfig({ optIn: false, projectId: "my-project-1" })).toThrow(
      "off by default",
    );
  });

  test("names the missing or malformed project id", () => {
    expect(() => resolveDeviceStreamingConfig({ optIn: true })).toThrow(
      "needs the Google Cloud project id",
    );
    expect(() => resolveDeviceStreamingConfig({ optIn: true, projectId: "My_Project" })).toThrow(
      '"My_Project" is not a Google Cloud project id',
    );
  });

  test("rejects a cap that is not a positive whole number", () => {
    for (const maxSessionMinutes of [0, -5, 2.5, Number.NaN]) {
      expect(() =>
        resolveDeviceStreamingConfig({ optIn: true, projectId: "my-project-1", maxSessionMinutes }),
      ).toThrow("positive whole number of minutes");
    }
  });
});

describe("createDeviceStreamingProvider", () => {
  test("builds the Device Streaming provider for a valid config", () => {
    const provider = createDeviceStreamingProvider(
      { optIn: true, projectId: "my-project-1" },
      { host: new FakeHostCommandExecutor(), timer: new FakeTimer() },
    );

    expect(provider).toBeInstanceOf(DeviceStreamingRemoteDeviceProvider);
  });

  test("an invalid config builds nothing", () => {
    expect(() =>
      createDeviceStreamingProvider(
        { optIn: false, projectId: "my-project-1" },
        { host: new FakeHostCommandExecutor(), timer: new FakeTimer() },
      ),
    ).toThrow("off by default");
  });
});
