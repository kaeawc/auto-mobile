import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeScreenshotPathProtection } from "../fakes/FakeScreenshotPathProtection";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { registerObserveTools } from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  SCREENSHOT_PATH_MIN_LIFETIME_MS,
  MAX_SCREENSHOT_PATH_PROTECTIONS,
} from "../../src/features/observe/ScreenshotRetention";

isolateToolRegistry();

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}
test("observe description and docs agree with the fixed retention contract", () => {
  registerObserveTools();
  const description = ToolRegistry.getTool("observe")!.description;
  const docs = normalizeWhitespace(
    readFileSync(new URL("../../docs/tools.md", import.meta.url), "utf8"),
  );
  expect(SCREENSHOT_PATH_MIN_LIFETIME_MS).toBe(600_000);
  expect(description.toLowerCase()).toContain(
    "each screenshot path is kept for at least 10 minutes after the response that returned it unless evicted early under capacity pressure",
  );
  expect(description.toLowerCase()).toContain("new captures are never refused");
  expect(docs).toContain("**at least 10 minutes after return**");
  expect(docs).toContain(`**128 MiB and ${MAX_SCREENSHOT_PATH_PROTECTIONS} files**`);
  expect(docs).toContain("process-start grace");
  expect(docs).toContain("screenshotExpiresAt");
});
test("documentation matching tolerates CRLF and wrapped lines", () => {
  expect(normalizeWhitespace("**at least 10 minutes after\r\nreturn**")).toBe(
    "**at least 10 minutes after return**",
  );
});

test("display all paths carry recomputed deadlines through finalization", async () => {
  const timer = new FakeTimer();
  timer.advanceTime(123);
  const protection = new FakeScreenshotPathProtection(timer);
  const result = structuredClone(loadAndroidHomeObserve().observe);
  result.backStack = undefined;
  result.screenshotPath = "/active.png";
  result.screenshotExpiresAt = 1;
  result.displays = [
    {
      display: result.display,
      screenSize: result.screenSize,
      systemInsets: result.systemInsets,
      screenshotPath: "/panel.png",
      screenshotExpiresAt: 1,
      freshness: { isFresh: true, ageMs: 0 },
    },
  ];
  const screen = new FakeObserveScreen();
  screen.setObserveResult(result);
  const notify = spyOn(ResourceRegistry, "notifyResourcesUpdated").mockResolvedValue(undefined);
  try {
    registerObserveTools({
      pathProtection: protection,
      createScreen: () => ({
        execute: screen.execute.bind(screen),
        executeDeviceRead: screen.execute.bind(screen),
        captureScreenshot: screen.captureScreenshot.bind(screen),
        appendRawViewHierarchy: screen.appendRawViewHierarchy.bind(screen),
        getMostRecentCachedObserveResult: screen.getMostRecentCachedObserveResult.bind(screen),
      }),
    });
    const tool = ToolRegistry.getTool("observe")!;
    const response = await tool.deviceAwareHandler!(
      { deviceId: "display-retention", name: "Fake", platform: "android" },
      tool.schema.parse({ display: "all" }),
    );
    const finalized = finalizeToolResponse(response, { name: "observe", args: { display: "all" } });
    expect(finalized.structuredContent).toMatchObject({
      screenshotPath: "/active.png",
      screenshotExpiresAt: 600_123,
      displays: [{ screenshotPath: "/panel.png", screenshotExpiresAt: 600_123 }],
    });
  } finally {
    notify.mockRestore();
    ToolRegistry.clearTools();
  }
});
