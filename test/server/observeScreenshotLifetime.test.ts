import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { registerObserveTools } from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  SCREENSHOT_MIN_LIFETIME_MS,
  SCREENSHOT_STALE_AGE_MS,
} from "../../src/features/observe/screenshotCacheEviction";
import { MAX_SCREENSHOT_PATH_PROTECTIONS } from "../../src/features/observe/ScreenshotPathProtection";

test("observe description and documentation agree with the retention constants", () => {
  registerObserveTools();
  const description = ToolRegistry.getTool("observe")!.description;
  const docs = readFileSync(new URL("../../docs/tools.md", import.meta.url), "utf8");
  expect(description).toContain(`${SCREENSHOT_MIN_LIFETIME_MS / 1000} seconds from return`);
  expect(description).toContain(`${SCREENSHOT_STALE_AGE_MS / (60 * 60 * 1000)} hours`);
  expect(docs).toContain(`**${SCREENSHOT_MIN_LIFETIME_MS / 1000} seconds\nfrom return**`);
  expect(docs).toContain(`**${SCREENSHOT_STALE_AGE_MS / (60 * 60 * 1000)} hours**`);
  expect(docs).toContain(`bounded to ${MAX_SCREENSHOT_PATH_PROTECTIONS} paths`);
});
