import { readGuardFile } from "./astGuard";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { APPLE_PLATFORM_SUPPORTED_TOOLS } from "../../src/server/applePlatformToolSupport";
import { TV_REMOTE_BUTTONS } from "../../src/features/tvos/TvosRunnerClient";

const doc = readGuardFile(join(import.meta.dir, "../../docs/using/apple-tv.md")).replace(
  /\r\n?/g,
  "\n",
);

function section(marker: string): string {
  const start = `<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  const from = doc.indexOf(start);
  const to = doc.indexOf(end);
  if (from < 0 || to < from) {
    throw new Error(`docs/using/apple-tv.md is missing the ${marker} markers`);
  }
  return doc.slice(from + start.length, to);
}

describe("Apple TV user guide", () => {
  test("the supported-tools table lists exactly the tools that accept tvOS", () => {
    const rows = section("apple-tv-supported-tools")
      .split("\n")
      .map((line) => /^\|\s*`([A-Za-z]+)`\s*\|/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(new Set(rows).size).toBe(rows.length);
    expect([...rows].sort()).toEqual([...APPLE_PLATFORM_SUPPORTED_TOOLS.tvos].sort());
  });

  test("the remote-button list matches the buttons the runner accepts", () => {
    const buttons = [...section("apple-tv-remote-buttons").matchAll(/`([A-Za-z]+)`/g)].map(
      (match) => match[1],
    );
    expect(buttons).toEqual([...TV_REMOTE_BUTTONS]);
  });
});
