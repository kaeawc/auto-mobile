import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BootedDevice } from "../../../src/models";
import type { DisplayPanel } from "../../../src/models/DisplayPanel";
import type {
  HostCommandExecutor,
  HostCommandOptions,
} from "../../../src/utils/HostCommandExecutor";
import { CoreDeviceCapabilityProbe } from "../../../src/utils/ios-cmdline-tools/CoreDeviceCapabilityProbe";
import {
  type DevicectlDisplayInfo,
  parseDevicectlDisplayInfo,
} from "../../../src/utils/ios-cmdline-tools/DevicectlDisplayInfo";
import {
  DEVICECTL_DISPLAYS_COMMAND,
  DevicectlDisplayScreenshotCapture,
  DevicectlPanelScreenshotSource,
  findDevicectlDisplayUniqueId,
  type SimulatorPanelScreenshotSource,
} from "../../../src/utils/ios-cmdline-tools/DevicectlDisplayScreenshot";
import { captureIosPanelScreenshotWith } from "../../../src/features/observe/ios/CtrlProxyScreenshot";
import {
  FakeDevicectlCommandInvoker,
  FakeDevicectlVersionSource,
  FakeSimulatorBootStateProvider,
} from "../../fakes/FakeCoreDeviceCapabilityDependencies";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeLogger } from "../../fakes/FakeLogger";
import { FakeSimulatorDisplayScreenshotCapture } from "../../fakes/FakeSimulatorDisplayScreenshotCapture";
import { FakeTimer } from "../../fakes/FakeTimer";
import { logger } from "../../../src/utils/logger";

const fixtureDir = join(process.cwd(), "test/fixtures/ios-devicectl");
// Captured #8872: `device info displays` on a booted single-display simulator.
const capturedDisplays = readFileSync(
  join(fixtureDir, "info-displays-booted-simulator.json"),
  "utf8",
);
const capturedVersion = readFileSync(join(fixtureDir, "version.txt"), "utf8");
const CAPTURED_UNIQUE_ID = "D93C043F-5B46-4213-B7A6-B6D082A5FAEE";
const capturedPanel: DisplayPanel = {
  key: "LCD",
  role: "unknown",
  sizePx: { width: 1206, height: 2622 },
};

/** Typed (not parsed) listings: selection takes parsed objects, so no raw JSON is fabricated. */
const twoDisplays: DevicectlDisplayInfo[] = [
  { uniqueId: "COVER-ID", displayId: 1, name: "cover", nativeSize: { width: 1398, height: 2034 } },
  { uniqueId: "INNER-ID", displayId: 2, name: "inner", nativeSize: { width: 2007, height: 2853 } },
];

const innerPanel: DisplayPanel = {
  key: "primary-1",
  role: "inner",
  sizePx: { width: 2007, height: 2853 },
};

function displaysOf(text: string) {
  const listing = parseDevicectlDisplayInfo(text, new FakeLogger());
  if (listing.kind !== "ok") {
    throw new Error("expected a parsed listing");
  }
  return listing.displays;
}

function sourceHarness() {
  const versionSource = new FakeDevicectlVersionSource(capturedVersion);
  const bootState = new FakeSimulatorBootStateProvider();
  const commandInvoker = new FakeDevicectlCommandInvoker();
  commandInvoker.result = { kind: "ok", output: capturedDisplays };
  const logger = new FakeLogger();
  const probe = new CoreDeviceCapabilityProbe({ versionSource, bootState, commandInvoker, logger });
  const capture = new FakeSimulatorDisplayScreenshotCapture();
  capture.result = Buffer.from("devicectl png");
  const source = new DevicectlPanelScreenshotSource({
    probes: { get: () => probe },
    capture,
    timer: new FakeTimer(),
    logger,
  });
  return { source, probe, versionSource, bootState, commandInvoker, capture, logger };
}

describe("findDevicectlDisplayUniqueId", () => {
  test("matches the captured display by name and by native size in either orientation", () => {
    const displays = displaysOf(capturedDisplays);
    expect(findDevicectlDisplayUniqueId(displays, capturedPanel)).toBe(CAPTURED_UNIQUE_ID);
    for (const sizePx of [
      { width: 1206, height: 2622 },
      { width: 2622, height: 1206 },
    ]) {
      expect(findDevicectlDisplayUniqueId(displays, { key: "other", sizePx })).toBe(
        CAPTURED_UNIQUE_ID,
      );
    }
  });

  test("returns no ID when neither name nor size identifies the panel", () => {
    expect(
      findDevicectlDisplayUniqueId(displaysOf(capturedDisplays), {
        key: "primary-1",
        sizePx: { width: 2007, height: 2853 },
      }),
    ).toBeUndefined();
  });

  test("selects one of several displays by size and refuses an ambiguous listing", () => {
    expect(findDevicectlDisplayUniqueId(twoDisplays, innerPanel)).toBe("INNER-ID");
    const ambiguous = twoDisplays.map((display) => ({
      ...display,
      name: "LCD",
      nativeSize: { width: 2007, height: 2853 },
    }));
    expect(findDevicectlDisplayUniqueId(ambiguous, innerPanel)).toBeUndefined();
    expect(findDevicectlDisplayUniqueId(ambiguous, { ...innerPanel, key: "LCD" })).toBeUndefined();
  });
});

describe("DevicectlPanelScreenshotSource", () => {
  test("supported: probes info displays and captures the panel by its unique ID", async () => {
    const h = sourceHarness();
    const signal = new AbortController().signal;
    const png = await h.source.capturePanel({
      deviceId: "sim-1",
      panel: capturedPanel,
      panelCount: 2,
      signal,
    });
    expect(png).toBe(h.capture.result);
    expect(h.commandInvoker.calls).toEqual([
      { deviceId: "sim-1", command: DEVICECTL_DISPLAYS_COMMAND },
    ]);
    expect(h.capture.calls).toEqual([
      { deviceId: "sim-1", displayUniqueId: CAPTURED_UNIQUE_ID, signal },
    ]);
    expect(h.probe.getCapabilities()).toMatchObject({
      status: "probed",
      entries: [{ command: DEVICECTL_DISPLAYS_COMMAND, status: "supported" }],
    });
  });

  test("unsupported: a 1001 falls back without capturing and is memoized", async () => {
    const h = sourceHarness();
    h.commandInvoker.result = {
      kind: "unsupported",
      capabilityFeatureId: "com.apple.coredevice.feature.displays",
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        await h.source.capturePanel({ deviceId: "sim-1", panel: capturedPanel, panelCount: 2 }),
      ).toBeUndefined();
    }
    expect(h.commandInvoker.calls).toHaveLength(1);
    expect(h.capture.calls).toHaveLength(0);
    expect(h.logger.at("debug")[0]?.message).toContain("coredevice-unsupported");
  });

  test("unsupported: a CoreDevice older than required never runs the command", async () => {
    const h = sourceHarness();
    h.probe.recordVersion({ kind: "available", version: [650, 9, 9] });
    expect(
      await h.source.capturePanel({ deviceId: "sim-1", panel: capturedPanel, panelCount: 2 }),
    ).toBeUndefined();
    expect(h.commandInvoker.calls).toHaveLength(0);
    expect(h.capture.calls).toHaveLength(0);
    expect(h.logger.at("debug")[0]?.message).toContain("requires CoreDevice >= 651.0.0");
  });

  test("not booted: falls back before any devicectl call and memoizes nothing", async () => {
    const h = sourceHarness();
    h.bootState.state = "shutdown";
    expect(
      await h.source.capturePanel({ deviceId: "sim-1", panel: capturedPanel, panelCount: 2 }),
    ).toBeUndefined();
    expect(h.versionSource.calls).toBe(0);
    expect(h.commandInvoker.calls).toHaveLength(0);
    expect(h.capture.calls).toHaveLength(0);
    expect(h.probe.getCapabilities().status).toBe("not probed");
    expect(h.logger.at("debug")[0]?.message).toContain("is shut down");
  });

  test("single display never calls devicectl or the probe", async () => {
    const h = sourceHarness();
    for (const panelCount of [0, 1]) {
      expect(
        await h.source.capturePanel({ deviceId: "sim-1", panel: capturedPanel, panelCount }),
      ).toBeUndefined();
    }
    expect(h.bootState.calls).toBe(0);
    expect(h.versionSource.calls).toBe(0);
    expect(h.commandInvoker.calls).toHaveLength(0);
    expect(h.capture.calls).toHaveLength(0);
  });

  test("re-reads the unique ID on every capture instead of caching it", async () => {
    const h = sourceHarness();
    for (let attempt = 0; attempt < 2; attempt++) {
      await h.source.capturePanel({ deviceId: "sim-1", panel: capturedPanel, panelCount: 2 });
    }
    expect(h.commandInvoker.calls).toHaveLength(2);
    expect(h.capture.calls.map((call) => call.displayUniqueId)).toEqual([
      CAPTURED_UNIQUE_ID,
      CAPTURED_UNIQUE_ID,
    ]);
  });

  test("an unmatched panel or unparsable listing falls back without capturing", async () => {
    const h = sourceHarness();
    expect(
      await h.source.capturePanel({ deviceId: "sim-1", panel: innerPanel, panelCount: 2 }),
    ).toBeUndefined();
    h.commandInvoker.result = { kind: "ok", output: "not json" };
    expect(
      await h.source.capturePanel({ deviceId: "sim-1", panel: capturedPanel, panelCount: 2 }),
    ).toBeUndefined();
    expect(h.capture.calls).toHaveLength(0);
    expect(h.logger.at("debug").map((entry) => entry.message)).toEqual([
      expect.stringContaining("no-unique-id"),
      expect.stringContaining("no-unique-id"),
    ]);
  });

  test("a devicectl capture failure falls back with a warning", async () => {
    const h = sourceHarness();
    h.capture.failure = new Error("devicectl screenshot failed: exit 1");
    expect(
      await h.source.capturePanel({ deviceId: "sim-1", panel: capturedPanel, panelCount: 2 }),
    ).toBeUndefined();
    expect(h.logger.at("warn")[0]?.message).toContain(
      "devicectl capture failed; using simctl: devicectl screenshot failed: exit 1",
    );
  });
});

function captureHarness(
  options: { result?: (args: string[]) => Promise<unknown>; readFailure?: Error } = {},
) {
  const calls: Array<{ file: string; args: string[]; options?: HostCommandOptions }> = [];
  const removed: string[] = [];
  const timer = new FakeTimer();
  const logger = new FakeLogger();
  const ok = new FakeHostCommandExecutor();
  const executor: HostCommandExecutor = {
    executeCommand: async (file, args = [], execOptions) => {
      calls.push({ file, args, options: execOptions });
      if (options.result) {
        await options.result(args);
      }
      return ok.executeCommand(file, args);
    },
  };
  const capture = new DevicectlDisplayScreenshotCapture({
    executor,
    files: {
      tmpdir: () => "/fake",
      mkdtemp: async (prefix) => `${prefix}1`,
      readFileBuffer: async () => {
        if (options.readFailure) {
          throw options.readFailure;
        }
        return Buffer.from("png bytes");
      },
      rm: async (path) => {
        removed.push(path);
      },
    },
    timer,
    timeoutMs: 10_000,
    logger,
  });
  return { capture, calls, removed, timer };
}

describe("DevicectlDisplayScreenshotCapture", () => {
  test("runs the built argv into a private directory, reads it, and removes the directory", async () => {
    const h = captureHarness();
    const png = await h.capture.capture({ deviceId: "sim-1", displayUniqueId: "panel-id" });
    expect(png.toString()).toBe("png bytes");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].file).toBe("xcrun");
    expect(h.calls[0].args).toEqual([
      "devicectl",
      "device",
      "capture",
      "screenshot",
      "--device",
      "sim-1",
      "--destination",
      join("/fake/automobile-devicectl-shot-1", "panel.png"),
      "--display-unique-id",
      "panel-id",
    ]);
    expect(h.calls[0].options).toMatchObject({ timeoutMs: 10_000, killSignal: "SIGKILL" });
    expect(h.removed).toEqual(["/fake/automobile-devicectl-shot-1"]);
  });

  test("rejects on its deadline, aborts the command, and still removes the directory", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const h = captureHarness({
      result: () => {
        started();
        return new Promise(() => {});
      },
    });
    const pending = h.capture.capture({ deviceId: "sim-1", displayUniqueId: "panel-id" });
    await running;
    h.timer.advanceTime(10_000);
    await expect(pending).rejects.toThrow("devicectl screenshot timed out after 10000ms");
    expect(h.calls[0].options?.signal?.aborted).toBe(true);
    expect(h.removed).toHaveLength(1);
  });

  test("a missing output file rejects and still removes the directory", async () => {
    const h = captureHarness({ readFailure: new Error("ENOENT: panel.png") });
    await expect(
      h.capture.capture({ deviceId: "sim-1", displayUniqueId: "panel-id" }),
    ).rejects.toThrow("ENOENT");
    expect(h.removed).toHaveLength(1);
  });
});

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe("captureIosPanelScreenshotWith", () => {
  const coverPanel: DisplayPanel = {
    key: "primary",
    role: "cover",
    sizePx: { width: 1398, height: 2034 },
  };
  const duo: BootedDevice = {
    deviceId: "sim-duo",
    name: "iPhone Duo",
    platform: "ios",
    displays: { panels: [coverPanel, innerPanel], postures: ["closed", "opened"] },
  };

  function run(options: { device?: BootedDevice; devicectlPng?: Buffer; simctlPng?: Buffer }) {
    const devicectlCalls: unknown[] = [];
    const simctlCalls: string[] = [];
    const devicectl: SimulatorPanelScreenshotSource = {
      capturePanel: async (request) => {
        devicectlCalls.push(request);
        return options.devicectlPng;
      },
    };
    const result = captureIosPanelScreenshotWith({
      device: options.device ?? duo,
      hierarchy: null,
      simctl: {
        screenshot: async (_deviceId, display) => {
          simctlCalls.push(display);
          return options.simctlPng ?? png(2007, 2853);
        },
      },
      devicectl,
      runnerCapture: async () => ({ success: true, data: "runner" }),
      activePanelKey: "primary-1",
    });
    return { result, devicectlCalls, simctlCalls };
  }

  test("uses a devicectl capture of the selected panel and skips simctl", async () => {
    const frame = png(2007, 2853);
    const h = run({ devicectlPng: frame });
    expect((await h.result).data).toBe(frame.toString("base64"));
    expect(h.devicectlCalls).toEqual([
      { deviceId: "sim-duo", panel: innerPanel, panelCount: 2, signal: undefined },
    ]);
    expect(h.simctlCalls).toEqual([]);
  });

  test("falls back to simctl when devicectl declines or returns the other panel", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      for (const devicectlPng of [undefined, png(1398, 2034), Buffer.from("not a png")]) {
        const simctlFrame = png(2853, 2007);
        const h = run({ devicectlPng, simctlPng: simctlFrame });
        expect((await h.result).data).toBe(simctlFrame.toString("base64"));
        expect(h.simctlCalls).toEqual(["primary-1"]);
      }
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringContaining("devicectl capture returned 1398x2034"),
        expect.stringContaining("devicectl capture returned unidentifiable"),
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a single-display simulator uses the runner and never touches devicectl", async () => {
    const h = run({
      device: { ...duo, displays: { panels: [innerPanel], postures: [] } },
      devicectlPng: png(2007, 2853),
    });
    expect((await h.result).data).toBe("runner");
    expect(h.devicectlCalls).toEqual([]);
    expect(h.simctlCalls).toEqual([]);
  });
});
