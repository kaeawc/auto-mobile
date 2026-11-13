import { describe, expect, test } from "bun:test";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { EmulatorReadinessPoller } from "../../../src/utils/android-cmdline-tools/EmulatorReadinessTypes";
import { PendingColdBootMarkerClears } from "../../../src/utils/android-cmdline-tools/PendingColdBootMarkerClears";
import { FakeAvdColdBootMarkerStore } from "../../fakes/FakeAvdColdBootMarkerStore";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";

const ready: BootedDevice = { name: "Pixel_9", platform: "android", deviceId: "emulator-5554" };

function setup(outcome: "ready" | "fail") {
  const timer = new FakeTimer();
  const markers = new FakeAvdColdBootMarkerStore();
  const clears = new PendingColdBootMarkerClears(() => markers);
  const poller: EmulatorReadinessPoller = {
    waitForEmulatorReady: async () => {
      // Readiness has not been reported yet, so the marker must still be there.
      expect(markers.marked.has("Pixel_9")).toBe(true);
      if (outcome === "fail") {
        throw new Error("readiness timed out");
      }
      return ready;
    },
    wakeAndUnlock: async () => {},
    detectOfflineFailure: async () => null,
  };
  const client = new AndroidEmulatorClient({
    execAsync: async (): Promise<ExecResult> => {
      throw new Error("no host commands in this test");
    },
    timer,
    avdColdBootMarkers: markers,
    pendingColdBootMarkerClears: clears,
    readinessPoller: poller,
  });
  return { client, markers, clears, child: new FakeChildProcess(timer) };
}

describe("AndroidEmulatorClient cold boot marker consumption", () => {
  test("consumes the marker once the launch that applied it is ready", async () => {
    const { client, markers, clears, child } = setup("ready");
    await markers.mark("Pixel_9");
    clears.track("Pixel_9", child);
    expect(await client.waitForEmulatorReady("Pixel_9", 1_000, child)).toEqual(ready);
    expect(markers.marked.has("Pixel_9")).toBe(false);
  });

  test("keeps the marker when readiness fails", async () => {
    const { client, markers, clears, child } = setup("fail");
    await markers.mark("Pixel_9");
    clears.track("Pixel_9", child);
    await expect(client.waitForEmulatorReady("Pixel_9", 1_000, child)).rejects.toThrow(
      "readiness timed out",
    );
    expect(markers.marked.has("Pixel_9")).toBe(true);
  });

  test("a ready wait for an AVD whose launch did not apply the marker leaves it", async () => {
    const { client, markers } = setup("ready");
    await markers.mark("Pixel_9");
    await client.waitForEmulatorReady("Pixel_9", 1_000, null);
    expect(markers.marked.has("Pixel_9")).toBe(true);
    expect(markers.calls).not.toContain("remove:Pixel_9");
  });
});
