import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  APPLE_PLATFORM_SUPPORTED_TOOLS,
  unsupportedPlatformToolMessage,
} from "../../src/server/applePlatformToolSupport";

const page = readFileSync(join(import.meta.dir, "../../docs/using/apple-watch.md"), "utf8");

/** Tool names listed between the page's watchOS supported-tools markers. */
function documentedTools(markdown: string): string[] {
  const match = markdown.match(
    /<!-- watchos-supported-tools:start -->([\s\S]*?)<!-- watchos-supported-tools:end -->/,
  );
  if (!match) {
    throw new Error("docs/using/apple-watch.md lost its watchos-supported-tools markers");
  }
  return [...match[1].matchAll(/^- `([A-Za-z]+)`\s*$/gm)].map((line) => line[1]);
}

describe("Apple Watch user doc (#14914)", () => {
  test("lists exactly the watchOS tool allowlist", () => {
    const listed = documentedTools(page);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...APPLE_PLATFORM_SUPPORTED_TOOLS.watchos].sort());
  });

  test("quotes the refusal every other tool returns", () => {
    const quoted = unsupportedPlatformToolMessage("<tool>", "watchos");
    expect(page).toContain(quoted);
  });
});
