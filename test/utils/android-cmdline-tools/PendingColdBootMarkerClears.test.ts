import { describe, expect, test } from "bun:test";
import { PendingColdBootMarkerClears } from "../../../src/utils/android-cmdline-tools/PendingColdBootMarkerClears";
import { FakeAvdColdBootMarkerStore } from "../../fakes/FakeAvdColdBootMarkerStore";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";

async function setup() {
  const markers = new FakeAvdColdBootMarkerStore();
  await markers.mark("Pixel_9");
  const clears = new PendingColdBootMarkerClears(() => markers);
  const child = new FakeChildProcess(new FakeTimer());
  return { markers, clears, child };
}

describe("PendingColdBootMarkerClears", () => {
  test("clears the marker once the tracked launch reaches readiness", async () => {
    const { markers, clears, child } = await setup();
    clears.track("Pixel_9", child);
    expect(clears.isPending("Pixel_9")).toBe(true);
    await clears.clearAfterReady("Pixel_9");
    expect(markers.marked.has("Pixel_9")).toBe(false);
    expect(clears.isPending("Pixel_9")).toBe(false);
  });

  for (const event of ["exit", "error"] as const) {
    test(`keeps the marker when the launch ends before readiness: ${event}`, async () => {
      const { markers, clears, child } = await setup();
      clears.track("Pixel_9", child);
      child.emit(event, event === "error" ? new Error("spawn failed") : 1);
      expect(clears.isPending("Pixel_9")).toBe(false);
      await clears.clearAfterReady("Pixel_9");
      expect(markers.marked.has("Pixel_9")).toBe(true);
      expect(markers.calls).not.toContain("remove:Pixel_9");
    });
  }

  test("a superseded launch's exit does not forget the newer launch", async () => {
    const { markers, clears, child } = await setup();
    const replacement = new FakeChildProcess(new FakeTimer());
    clears.track("Pixel_9", child);
    clears.track("Pixel_9", replacement);
    child.emit("exit", 1);
    await clears.clearAfterReady("Pixel_9");
    expect(markers.marked.has("Pixel_9")).toBe(false);
  });

  test("a readiness wait for an untracked AVD leaves its marker", async () => {
    const { markers, clears } = await setup();
    await clears.clearAfterReady("Pixel_9");
    expect(markers.calls).toEqual(["write:Pixel_9"]);
  });

  test("a clear failure is logged, not thrown", async () => {
    const { markers, clears, child } = await setup();
    markers.failure = "remove";
    clears.track("Pixel_9", child);
    await clears.clearAfterReady("Pixel_9");
    expect(markers.marked.has("Pixel_9")).toBe(true);
  });
});
