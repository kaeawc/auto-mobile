import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  captureWatchSimctlScreenshot,
  WATCH_SIMCTL_DEFAULT_DISPLAY,
  watchScreenshotDisplay,
} from "../../../src/features/watch/WatchScreenshot";

const watch: BootedDevice = {
  name: "Apple Watch Series 10",
  platform: "watchos",
  deviceId: "AEC5C81F-B29B-4A0C-976A-6081F3617E1C",
};

describe("watch simctl screenshot (#19056)", () => {
  test("captures through simctl io screenshot on the display observe uses", async () => {
    const calls: Array<[string, string | undefined, AbortSignal | undefined]> = [];
    const frame = Buffer.from("png");
    const signal = new AbortController().signal;
    const result = await captureWatchSimctlScreenshot(watch, signal, () => ({
      screenshot: async (deviceId, display, callSignal) => {
        calls.push([deviceId, display, callSignal]);
        return frame;
      },
    }));
    expect(result).toBe(frame);
    expect(calls).toEqual([[watch.deviceId, "main", signal]]);
  });

  test("uses the inventoried panel key when the watch reports one, else main", () => {
    expect(WATCH_SIMCTL_DEFAULT_DISPLAY).toBe("main");
    expect(watchScreenshotDisplay(watch)).toBe("main");
    const displays = {
      panels: [
        { key: "watch-panel", role: "unknown" as const, sizePx: { width: 396, height: 484 } },
      ],
      postures: [],
    };
    expect(watchScreenshotDisplay({ displays })).toBe("watch-panel");
  });
});
