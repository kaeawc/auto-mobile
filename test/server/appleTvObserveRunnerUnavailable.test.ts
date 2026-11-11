import { afterEach, describe, expect, test } from "bun:test";
import { TvosRunnerTimeoutError } from "../../src/features/tvos/TvosRunnerTimeoutError";
import { tvosRunners } from "../../src/features/tvos/TvosRunnerRegistry";
import type { BootedDevice } from "../../src/models";
import {
  TVOS_RUNNER_UNAVAILABLE_MESSAGE,
  isWatchObservation,
  type WatchObservation,
} from "../../src/models/WatchObservation";
import type { ObserveArgs } from "../../src/server/observeTools";
import {
  defaultWatchScreenshotSource,
  observeWatch,
  simctlWatchScreenshotSource,
  type WatchScreenshotSource,
} from "../../src/server/observeWatch";
import { observeToolResultSchema } from "../../src/server/toolOutputSchemas";
import { CountingIdGenerator } from "../../src/utils/CountingIdGenerator";
import { getStructuredPayload } from "../../src/utils/toolUtils";
import { FakeScreenshotFileWriter } from "../fakes/FakeScreenshotFileWriter";
import { FakeScreenshotPathProtection } from "../fakes/FakeScreenshotPathProtection";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeTvosRunnerClient } from "../fakes/FakeTvosRunnerClient";

// A registered tvOS runner that is stuck or fails degrades observe to a screenshot marked
// hierarchyUnavailable instead of failing the call, as visionOS does (#17310).

const appleTv: BootedDevice = {
  name: "Apple TV 4K",
  deviceId: "6B1F3C2E-0000-4000-8000-00000017310A",
  platform: "tvos",
};

function pngOfSize(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

class RecordingScreenshots implements WatchScreenshotSource {
  captures = 0;
  async capture(): Promise<Buffer> {
    this.captures++;
    return pngOfSize(1920, 1080);
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const run of cleanups.splice(0)) {
    run();
  }
});

function arrange(failure: Error) {
  const runner = new FakeTvosRunnerClient();
  const hierarchy = runner.hierarchy.bind(runner);
  runner.hierarchy = (signal) => {
    // Fail during this read, rather than presenting an already-disconnected runner to recovery.
    runner.failure = failure;
    return hierarchy(signal);
  };
  cleanups.push(tvosRunners.register(appleTv.deviceId, runner));
  const timer = new FakeTimer();
  const screenshots = new RecordingScreenshots();
  const writer = new FakeScreenshotFileWriter();
  const observe = (args: ObserveArgs = {}, signal?: AbortSignal) =>
    observeWatch(appleTv, args, signal, {
      screenshots,
      timer,
      idGenerator: new CountingIdGenerator("tv-unavailable"),
      fileWriter: writer,
      pathProtection: new FakeScreenshotPathProtection(timer),
      cacheDir: () => "/cache/screenshots",
    });
  return { observe, runner, screenshots, writer };
}

const settle = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("observe on an Apple TV whose runner does not return a hierarchy", () => {
  test("a stuck runner returns the screenshot marked hierarchyUnavailable with the reason", async () => {
    const stuck = new TvosRunnerTimeoutError("request_hierarchy", 5000);
    const { observe, runner, screenshots, writer } = arrange(stuck);
    const result = getStructuredPayload<WatchObservation>(await observe())!;
    expect(isWatchObservation(result)).toBe(true);
    expect(result.hierarchyUnavailable.platform).toBe("tvos");
    expect(result.hierarchyUnavailable.message).toBe(
      `${TVOS_RUNNER_UNAVAILABLE_MESSAGE} Runner unavailable: ${stuck.message}`,
    );
    expect(result.screenSize).toEqual({ width: 1920, height: 1080, units: "physical-pixels" });
    expect(writer.written).toEqual([result.screenshotPath!]);
    for (const field of ["viewHierarchy", "elements", "focusedElement", "systemInsets"]) {
      expect(Object.hasOwn(result, field)).toBe(false);
    }
    expect(observeToolResultSchema.safeParse(result).success).toBe(true);
    expect(runner.commands).toEqual([{ type: "request_hierarchy" }]);
    expect(screenshots.captures).toBe(1);
  });

  test("hierarchy-only options are refused once the runner fails, before capturing", async () => {
    const { observe, screenshots } = arrange(new Error("runner disconnected"));
    const error = await settle(observe({ project: "full" }));
    expect(String(error)).toContain("returns only a screenshot");
    expect(String(error)).toContain("does not support: project");
    expect(screenshots.captures).toBe(0);
  });

  test("a cancelled observe still rejects instead of degrading", async () => {
    const { observe, screenshots } = arrange(new Error("runner disconnected"));
    const controller = new AbortController();
    controller.abort();
    await expect(observe({}, controller.signal)).rejects.toThrow();
    expect(screenshots.captures).toBe(0);
  });

  test("the fallback screenshot comes from simctl, not the runner that just failed", () => {
    const runner = new FakeTvosRunnerClient();
    cleanups.push(tvosRunners.register(appleTv.deviceId, runner));
    expect(defaultWatchScreenshotSource(appleTv)).not.toBe(simctlWatchScreenshotSource);
    expect(defaultWatchScreenshotSource(appleTv, false)).toBe(simctlWatchScreenshotSource);
    runner.close();
    expect(defaultWatchScreenshotSource(appleTv)).toBe(simctlWatchScreenshotSource);
  });
});
