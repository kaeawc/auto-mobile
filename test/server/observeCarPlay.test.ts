import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SCREENSHOT_PATH_MIN_LIFETIME_MS } from "../../src/features/observe/ScreenshotRetention";
import { ActionableError, type BootedDevice } from "../../src/models";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { observeCarPlay, type CarPlayObserveDependencies } from "../../src/server/observeCarPlay";
import type { ObserveArgs } from "../../src/server/observeTools";
import { observeToolResultSchema } from "../../src/server/toolOutputSchemas";
import { CountingIdGenerator } from "../../src/utils/CountingIdGenerator";
import { parseSimulatorScreens } from "../../src/utils/ios-cmdline-tools/SimulatorDisplays";
import type { CarPlayProjectionState } from "../../src/utils/ios/carPlayProjection";
import { FakeCarPlayRuntimeReader } from "../fakes/FakeCarPlayRuntimeReader";
import { FakeScreenshotFileWriter } from "../fakes/FakeScreenshotFileWriter";
import { FakeScreenshotPathProtection } from "../fakes/FakeScreenshotPathProtection";
import { FakeTimer } from "../fakes/FakeTimer";
import { loadDuoEnumerate } from "../fixtures/loadDuoEnumerate";
import { pngHeader } from "../helpers/pngFixtures";

const simulator: BootedDevice = {
  platform: "ios",
  name: "iPhone Duo",
  deviceId: "6B1F3C2E-0000-4000-8000-00000000A7C1",
};
const cacheDir = "/cache/screenshots";
const now = 1_700_000_000_000;
const enumerateOutput = loadDuoEnumerate();
const projecting: CarPlayProjectionState = {
  found: true,
  tag: 32,
  displayId: 4,
  displayType: 2,
  identity: "Car[4]",
  name: "CarPlay",
  deviceName: "CarPlay",
  isCarDisplay: true,
  isCarInstrumentsDisplay: false,
};

function arrange(
  options: {
    state?: CarPlayProjectionState;
    missingScreen?: boolean;
    png?: Buffer;
    runtime?: string;
  } = {},
) {
  const calls: string[] = [];
  const timer = new FakeTimer();
  timer.setCurrentTime(now);
  const writer = new FakeScreenshotFileWriter();
  const protection = new FakeScreenshotPathProtection(timer);
  const runtime = new FakeCarPlayRuntimeReader(options.runtime);
  const dependencies: CarPlayObserveDependencies = {
    runtime,
    projectionProbe: {
      async probe(deviceId) {
        calls.push(`probe ${deviceId}`);
        return options.state ?? projecting;
      },
    },
    simctl: {
      async enumerateScreens(deviceId) {
        calls.push(`enumerate ${deviceId}`);
        const screens = parseSimulatorScreens(enumerateOutput);
        return options.missingScreen ? { ...screens, auxiliary: [] } : screens;
      },
      async screenshot(deviceId, display) {
        calls.push(`screenshot ${deviceId} ${display}`);
        return options.png ?? pngHeader(800, 480);
      },
    },
    timer,
    idGenerator: new CountingIdGenerator("carplay"),
    fileWriter: writer,
    pathProtection: protection,
    cacheDir: () => cacheDir,
  };
  const observe = (args: ObserveArgs = {}) =>
    observeCarPlay(simulator, { ...args, display: "carplay" }, undefined, dependencies);
  return { observe, calls, runtime, writer, protection, timer };
}

describe("observe on an iOS simulator's CarPlay screen", () => {
  test("probes projection, selects the named screen, and returns a retained PNG", async () => {
    const { observe, calls, writer, protection, timer } = arrange();
    const response = finalizeToolResponse(await observe(), {
      name: "observe",
      args: { display: "carplay" },
    });
    const result = response.structuredContent!;

    expect(calls).toEqual([
      `probe ${simulator.deviceId}`,
      `enumerate ${simulator.deviceId}`,
      `screenshot ${simulator.deviceId} wireless0`,
    ]);
    expect(result).toMatchObject({
      observationId: "carplay-1",
      deviceId: simulator.deviceId,
      display: { key: "carplay", role: "external" },
      screenSize: { width: 800, height: 480, units: "physical-pixels" },
      screenshotMimeType: "image/png",
      screenshotExpiresAt: now + SCREENSHOT_PATH_MIN_LIFETIME_MS,
      hierarchyUnavailable: { platform: "ios" },
    });
    expect(result.hierarchyUnavailable?.message).toContain("CarPlay has no runner hierarchy");
    expect(result.screenshotPath).toStartWith(join(cacheDir, `screenshot_${now}_`));
    expect(writer.written).toEqual([result.screenshotPath!]);
    expect(protection.isProtected(result.screenshotPath!)).toBe(true);
    expect(timer.getSleepHistory()).toEqual([]);
    expect(result).not.toHaveProperty("viewHierarchy");
    expect(result).not.toHaveProperty("skeleton");
    expect(observeToolResultSchema.parse(result)).toMatchObject({ display: result.display });
  });

  test("refuses an attached non-projecting screen before enumeration or capture", async () => {
    const { observe, calls, writer } = arrange({
      state: { ...projecting, tag: 4, identity: "AirPlay[4]", isCarDisplay: false },
    });
    const response = observe();
    await expect(response).rejects.toThrow(ActionableError);
    await expect(response).rejects.toThrow(
      "CarPlay screen CarPlay is attached but not projecting (AirPlay[4]). Capture was skipped because the frame would be black. Run carplay-power-helper power-on (ios/carplay-power) after every boot of an iOS 26.x simulator, then retry; the iOS 27 Simulator does not support CarPlay.",
    );
    expect(calls).toEqual([`probe ${simulator.deviceId}`]);
    expect(writer.written).toEqual([]);
  });

  test("refuses an iOS 27 simulator with unsupported-runtime before probing (#19185)", async () => {
    const { observe, calls, runtime, writer } = arrange({ runtime: "27.2" });
    await expect(observe()).rejects.toThrow(
      "[unsupported-runtime] Headless CarPlay needs an iOS 26.x runtime (found 27.2)",
    );
    expect(runtime.calls).toEqual([simulator.deviceId]);
    expect(calls).toEqual([]);
    expect(writer.written).toEqual([]);
  });

  test("refuses to capture if enumeration has no CarPlay screen", async () => {
    const { observe, calls } = arrange({ missingScreen: true });
    await expect(observe()).rejects.toThrow("Expected one named CarPlay screen");
    expect(calls).toEqual([`probe ${simulator.deviceId}`, `enumerate ${simulator.deviceId}`]);
  });

  test("refuses hierarchy options before probing", async () => {
    const { observe, calls } = arrange();
    await expect(observe({ raw: true, project: "full" })).rejects.toThrow(
      "CarPlay observe returns only a screenshot and does not support raw, project.",
    );
    expect(calls).toEqual([]);
  });

  test.each([
    ["non-PNG bytes", Buffer.from("not a PNG")],
    ["a PNG header with zero width", pngHeader(0, 480)],
  ])("refuses to retain %s", async (_label, png) => {
    const { observe, writer } = arrange({ png });
    await expect(observe()).rejects.toThrow("simctl returned no readable PNG for CarPlay");
    expect(writer.written).toEqual([]);
  });
});
