import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { registerObserveTools } from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  SCREENSHOT_MIN_LIFETIME_MS,
  SCREENSHOT_STALE_AGE_MS,
} from "../../src/features/observe/screenshotCacheEviction";
import { MAX_SCREENSHOT_PATH_PROTECTIONS } from "../../src/features/observe/ScreenshotPathProtection";

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

test("observe description and documentation agree with the retention constants", () => {
  registerObserveTools();
  const description = ToolRegistry.getTool("observe")!.description;
  const docs = normalizeWhitespace(
    readFileSync(new URL("../../docs/tools.md", import.meta.url), "utf8"),
  );
  expect(description).toContain(`${SCREENSHOT_MIN_LIFETIME_MS / 1000} seconds from return`);
  expect(description).toContain(`${SCREENSHOT_STALE_AGE_MS / (60 * 60 * 1000)} hours`);
  expect(docs).toContain(`**${SCREENSHOT_MIN_LIFETIME_MS / 1000} seconds from return**`);
  expect(docs).toContain(`**${SCREENSHOT_STALE_AGE_MS / (60 * 60 * 1000)} hours**`);
  expect(docs).toContain(`bounded to ${MAX_SCREENSHOT_PATH_PROTECTIONS} paths`);
});

test("documentation matching tolerates CRLF and wrapped lines", () => {
  const sample = `**${SCREENSHOT_MIN_LIFETIME_MS / 1000} seconds\r\nfrom\nreturn**\r\n**${SCREENSHOT_STALE_AGE_MS / (60 * 60 * 1000)}\r\nhours**\r\nbounded\r\nto ${MAX_SCREENSHOT_PATH_PROTECTIONS}\tpaths`;
  const normalized = normalizeWhitespace(sample);
  expect(normalized).toContain(`**${SCREENSHOT_MIN_LIFETIME_MS / 1000} seconds from return**`);
  expect(normalized).toContain(`**${SCREENSHOT_STALE_AGE_MS / (60 * 60 * 1000)} hours**`);
  expect(normalized).toContain(`bounded to ${MAX_SCREENSHOT_PATH_PROTECTIONS} paths`);
});
