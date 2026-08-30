import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";

// Issue #5854 §2: the daemon client encodes non-finite arguments as sentinels so
// they survive the wire. The CallTool handler must revive them BEFORE schema
// validation, so a sentinel-encoded Infinity is rejected as a real non-finite
// number ("must be a finite number") rather than as a stray object.
describe("CallTool handler revives non-finite sentinels before validation", () => {
  let fixture: McpTestFixture;

  beforeAll(async () => {
    fixture = new McpTestFixture();
    await fixture.setup();
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.teardown();
    }
  });

  test("a sentinel-encoded duration is rejected as a non-finite number", async () => {
    const { client } = fixture.getContext();

    const call = client.request(
      {
        method: "tools/call",
        params: {
          name: "tapOn",
          arguments: {
            platform: "android",
            selector: { text: "Gmail" },
            action: "longPress",
            // The exact shape the daemon client puts on the wire for `Infinity`,
            // plus the transport-provenance flag it stamps alongside it (#5863).
            duration: { __autoMobileNonFinite__: "Infinity" },
            __autoMobileNonFiniteEncoded: true,
          },
        },
      },
      z.object({}).passthrough(),
    );

    // The handler revives the sentinel to Infinity, so validation names the
    // finite constraint instead of complaining about an object-typed duration.
    await expect(call).rejects.toThrow(/duration must be a finite number/);
  });

  // #5863 AC2: a request WITHOUT the provenance flag (e.g. a direct in-memory /
  // stdio client that never sentinel-encoded) is not revived, so a bare
  // sentinel-shaped object stays an object and is NOT reported as a non-finite
  // number — proving revival is scoped by provenance, not applied blindly.
  test("an unflagged sentinel-shaped duration is not revived to a non-finite number", async () => {
    const { client } = fixture.getContext();

    const call = client.request(
      {
        method: "tools/call",
        params: {
          name: "tapOn",
          arguments: {
            platform: "android",
            selector: { text: "Gmail" },
            action: "longPress",
            duration: { __autoMobileNonFinite__: "Infinity" },
          },
        },
      },
      z.object({}).passthrough(),
    );

    // No provenance flag → the object is left as-is and rejected as a type
    // mismatch, never as "must be a finite number".
    await expect(call).rejects.toThrow();
    await expect(call).rejects.not.toThrow(/duration must be a finite number/);
  });
});
