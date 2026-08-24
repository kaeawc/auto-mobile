import { describe, expect, test } from "bun:test";
import {
  IOS_DEVICE_LOG_DEFAULT_MAX_ENTRIES,
  IOS_DEVICE_LOG_DEFAULT_WINDOW,
  IOS_DEVICE_LOG_MAX_BYTES,
  IOS_DEVICE_LOG_MAX_ENTRIES,
  IosDeviceLogCollector,
  buildIosLogPredicate,
} from "../../../src/features/debug/IosDeviceLogCollector";
import type { BootedDevice } from "../../../src/models";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";

describe("IosDeviceLogCollector", () => {
  const device: BootedDevice = {
    deviceId: "sim-udid-1",
    platform: "ios",
    isEmulator: true,
    name: "iPhone 15 Simulator",
  };

  const unfilteredArgs = (window = IOS_DEVICE_LOG_DEFAULT_WINDOW): string[] => [
    "spawn",
    device.deviceId,
    "log",
    "show",
    "--style",
    "syslog",
    "--last",
    window,
  ];

  const filteredArgs = (appId: string, window = IOS_DEVICE_LOG_DEFAULT_WINDOW): string[] => [
    ...unfilteredArgs(window),
    "--predicate",
    buildIosLogPredicate(appId),
  ];

  const line = (n: number): string =>
    `2026-08-24 10:00:0${n}.000000-0700  localhost App[123]: entry-${n}`;

  test("AC1: returns ordered device-log entries from the bounded window", async () => {
    const simctl = new FakeSimCtlClient();
    const stdout = [line(1), line(2), line(3)].join("\n");
    simctl.setCommandArgsResult(unfilteredArgs(), stdout);

    const collector = new IosDeviceLogCollector(simctl, device);
    const result = await collector.collect({ maxEntries: 1000 });

    expect(result.status).toBe("collected");
    expect(result.entries).toEqual([line(1), line(2), line(3)]);
    expect(result.entryCount).toBe(3);
    expect(result.window.duration).toBe(IOS_DEVICE_LOG_DEFAULT_WINDOW);
    expect(result.window.maxEntries).toBe(1000);
    expect(result.appFilter).toBeUndefined();
    expect(result.byteSize).toBe(Buffer.byteLength(result.entries.join("\n"), "utf8"));
  });

  test("AC4: bounds entries to maxEntries, keeping the most recent in order", async () => {
    const simctl = new FakeSimCtlClient();
    const stdout = [line(1), line(2), line(3), line(4), line(5)].join("\n");
    simctl.setCommandArgsResult(unfilteredArgs(), stdout);

    const collector = new IosDeviceLogCollector(simctl, device);
    const result = await collector.collect({ maxEntries: 2 });

    expect(result.entries).toEqual([line(4), line(5)]);
    expect(result.entryCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("maxEntries");
    expect(result.limits.maxEntries).toBe(2);
    expect(result.limits.maxBytes).toBe(IOS_DEVICE_LOG_MAX_BYTES);
  });

  test("AC4: bounds entries to the documented byte limit, dropping oldest", async () => {
    const simctl = new FakeSimCtlClient();
    // Each entry ~1 KiB; 300 entries (~300 KiB) exceeds the 256 KiB byte ceiling.
    const big: string[] = [];
    for (let i = 0; i < 300; i++) {
      big.push(`2026-08-24 10:00:00.000000-0700  localhost App[123]: ${"x".repeat(1024)}-${i}`);
    }
    simctl.setCommandArgsResult(unfilteredArgs(), big.join("\n"));

    const collector = new IosDeviceLogCollector(simctl, device);
    const result = await collector.collect({ maxEntries: 100000 });

    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("maxBytes");
    expect(result.byteSize).toBeLessThanOrEqual(IOS_DEVICE_LOG_MAX_BYTES);
    // Oldest dropped, most-recent retained.
    expect(result.entries[result.entries.length - 1]).toBe(big[big.length - 1]);
    expect(result.entries).not.toContain(big[0]);
  });

  test("AC4: applies the documented default entry limit when none is requested", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(unfilteredArgs(), [line(1)].join("\n"));

    const collector = new IosDeviceLogCollector(simctl, device);
    const result = await collector.collect();

    expect(result.limits.maxEntries).toBe(IOS_DEVICE_LOG_DEFAULT_MAX_ENTRIES);
    expect(result.window.maxEntries).toBe(IOS_DEVICE_LOG_DEFAULT_MAX_ENTRIES);
    expect(result.limits.maxBytes).toBe(IOS_DEVICE_LOG_MAX_BYTES);
  });

  test("AC4: caps a request above the documented hard entry ceiling", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(unfilteredArgs(), [line(1)].join("\n"));

    const collector = new IosDeviceLogCollector(simctl, device);
    const result = await collector.collect({ maxEntries: IOS_DEVICE_LOG_MAX_ENTRIES * 100 });

    expect(result.limits.maxEntries).toBe(IOS_DEVICE_LOG_MAX_ENTRIES);
    expect(result.window.maxEntries).toBe(IOS_DEVICE_LOG_MAX_ENTRIES);
  });

  test("AC2: records filtering as applied when the predicated query succeeds", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(filteredArgs("com.example.app"), [line(1), line(2)].join("\n"));

    const collector = new IosDeviceLogCollector(simctl, device);
    const result = await collector.collect({ appId: "com.example.app" });

    expect(result.status).toBe("collected");
    expect(result.appFilter).toEqual({ appId: "com.example.app", status: "applied" });
    expect(result.entries).toEqual([line(1), line(2)]);
  });

  test("AC2: records filtering as unsupported when predicate fails but unfiltered succeeds", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsError(
      filteredArgs("com.example.app"),
      new Error("Invalid predicate: unknown key"),
    );
    simctl.setCommandArgsResult(unfilteredArgs(), [line(1)].join("\n"));

    const collector = new IosDeviceLogCollector(simctl, device);
    const result = await collector.collect({ appId: "com.example.app" });

    expect(result.status).toBe("collected");
    expect(result.appFilter).toEqual({ appId: "com.example.app", status: "unsupported" });
    expect(result.entries).toEqual([line(1)]);
  });

  test("AC2/AC3: records filtering as unavailable when collection fails entirely", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsError(filteredArgs("com.example.app"), new Error("device not booted"));
    simctl.setCommandArgsError(unfilteredArgs(), new Error("device not booted"));

    const collector = new IosDeviceLogCollector(simctl, device);
    const result = await collector.collect({ appId: "com.example.app" });

    expect(result.status).toBe("unavailable");
    expect(result.appFilter).toEqual({ appId: "com.example.app", status: "unavailable" });
    expect(result.entries).toEqual([]);
    expect(result.entryCount).toBe(0);
    expect(result.diagnostic).toContain("device not booted");
  });

  test("AC3: unfiltered collection failure returns structured status without throwing", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsError(unfilteredArgs(), new Error("simctl unavailable"));

    const collector = new IosDeviceLogCollector(simctl, device);
    const result = await collector.collect();

    expect(result.status).toBe("unavailable");
    expect(result.entries).toEqual([]);
    expect(result.diagnostic).toContain("simctl unavailable");
    expect(result.appFilter).toBeUndefined();
  });

  test("redacts credentials from captured entries", async () => {
    const simctl = new FakeSimCtlClient();
    const secret = "2026-08-24 10:00:01.000000-0700  localhost App[123]: token=SUPERSECRET123";
    simctl.setCommandArgsResult(unfilteredArgs(), secret);

    const collector = new IosDeviceLogCollector(simctl, device);
    const result = await collector.collect();

    expect(result.entries[0]).toContain("[REDACTED]");
    expect(result.entries.join("\n")).not.toContain("SUPERSECRET123");
  });

  test("uses a custom time window when provided", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(unfilteredArgs("30s"), [line(1)].join("\n"));

    const collector = new IosDeviceLogCollector(simctl, device);
    const result = await collector.collect({ window: "30s" });

    expect(result.status).toBe("collected");
    expect(result.window.duration).toBe("30s");
    expect(result.entries).toEqual([line(1)]);
  });
});
