import { describe, expect, test } from "bun:test";
import { NetsimBleTransportResolver } from "../../../src/features/blePeripheral/BleTransportResolver";
import { FakeBleTransportSources } from "../../fakes/FakeBleTransportSources";

describe("BLE netsim transport selection", () => {
  test("no target and a default-netsim emulator fall back to android-netsim", async () => {
    const sources = new FakeBleTransportSources();
    const resolver = new NetsimBleTransportResolver(sources);
    expect(await resolver.resolve()).toBe("android-netsim");
    expect(sources.reads).toBe(0);
    expect(await resolver.resolve("emulator-5554")).toBe("android-netsim");
  });

  test("explicit transport bypasses discovery even for non-emulator targets", async () => {
    const sources = new FakeBleTransportSources();
    const resolver = new NetsimBleTransportResolver(sources);
    expect(await resolver.resolve("device", "android-netsim:localhost:12345")).toBe(
      "android-netsim:localhost:12345",
    );
    expect(sources.reads).toBe(0);
  });

  test.each([
    "-packet-streamer-endpoint localhost:12345",
    "-packet-streamer-endpoint=localhost:12345",
  ])("uses the device's private endpoint: %s", async (endpoint) => {
    const sources = new FakeBleTransportSources();
    sources.rows = [
      {
        pid: 10,
        ppid: 1,
        command: [
          "/sdk/qemu/darwin-aarch64/qemu-system-aarch64",
          "-avd",
          "Pixel_A",
          "-port",
          "5554",
          endpoint,
        ].join(" "),
      },
      {
        pid: 11,
        ppid: 1,
        command: [
          "/sdk/qemu/darwin-aarch64/qemu-system-aarch64",
          "-avd",
          "Pixel_B",
          "-port",
          "5556",
          "-packet-streamer-endpoint",
          "localhost:23456",
        ].join(" "),
      },
    ];
    const resolver = new NetsimBleTransportResolver(sources);
    expect(await resolver.resolve("emulator-5554")).toBe("android-netsim:localhost:12345");
    expect(await resolver.resolve("emulator-5556")).toBe("android-netsim:localhost:23456");
  });

  test("correlates the live advertisement PID after a daemon restart", async () => {
    const sources = new FakeBleTransportSources();
    sources.advertised = {
      pid: 20,
      consolePort: 5554,
      address: "localhost:8554",
      auth: { kind: "none" },
      descriptionFile: "/fake/pid_20.ini",
    };
    sources.rows = [
      {
        pid: 20,
        ppid: 1,
        command: [
          "qemu-system-aarch64",
          "-avd",
          "Pixel",
          "-packet-streamer-endpoint",
          "localhost:12345",
        ].join(" "),
      },
    ];
    expect(await new NetsimBleTransportResolver(sources).resolve("emulator-5554")).toBe(
      "android-netsim:localhost:12345",
    );
  });

  test("unreadable inventory refuses to silently join the shared netsim", async () => {
    const sources = new FakeBleTransportSources();
    sources.incomplete = true;
    await expect(new NetsimBleTransportResolver(sources).resolve("emulator-5554")).rejects.toThrow(
      /supply transport/,
    );
  });

  test("unsupported device and malformed private endpoint are actionable", async () => {
    const sources = new FakeBleTransportSources();
    const resolver = new NetsimBleTransportResolver(sources);
    await expect(resolver.resolve("physical-device")).rejects.toThrow(/Android emulator serial/);
    sources.rows = [
      {
        pid: 10,
        ppid: 1,
        command: "qemu-system-aarch64 -port 5554 -packet-streamer-endpoint localhost:70000",
      },
    ];
    await expect(resolver.resolve("emulator-5554")).rejects.toThrow(/explicit Bumble transport/);
  });

  test("a stale or mismatched advertisement cannot select a different emulator's netsim", async () => {
    const sources = new FakeBleTransportSources();
    sources.advertised = {
      pid: 20,
      consolePort: 5554,
      address: "localhost:8554",
      auth: { kind: "none" },
      descriptionFile: "/fake/pid_20.ini",
    };
    const resolver = new NetsimBleTransportResolver(sources);
    await expect(resolver.resolve("emulator-5554")).rejects.toThrow(/could not be identified/);
    sources.rows = [
      {
        pid: 20,
        ppid: 1,
        command: "qemu-system-aarch64 -port 5556 -packet-streamer-endpoint localhost:12345",
      },
    ];
    await expect(resolver.resolve("emulator-5554")).rejects.toThrow(/ports disagree/);
  });
});
