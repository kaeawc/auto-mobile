import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";

// Issue #5854 §2: the daemon client encodes non-finite arguments as sentinels so
// they survive the wire. The CallTool handler must revive them BEFORE schema
// validation, so a sentinel-encoded Infinity is rejected as a real non-finite
// number ("must be a finite number") rather than as a stray object.
//
// Issue #5919 hardens the provenance gate: revival is scoped to `daemonMode`, a
// server-CONSTRUCTION boundary the tool caller cannot influence, so only the
// daemon's own loopback MCP server (created with `daemonMode: true`) ever revives.
// The daemon client is the only producer of sentinel-encoded requests, and its
// requests always terminate at that server — so a direct in-memory / stdio client
// (`daemonMode: false`) can never assert daemon transport provenance by forging the
// in-arguments flag.
describe("CallTool handler revives non-finite sentinels only for daemon-forwarded requests", () => {
  // The daemon's loopback MCP server is created with `daemonMode: true`
  // (`daemon.ts` StreamableHTTP transport setup). Revival is scoped to it.
  let daemonFixture: McpTestFixture;
  // A direct in-memory / stdio client's server is `daemonMode: false` (the default
  // in the stdio entrypoint and every embedded consumer).
  let directFixture: McpTestFixture;

  beforeAll(async () => {
    daemonFixture = new McpTestFixture({ daemonMode: true });
    await daemonFixture.setup();
    directFixture = new McpTestFixture({ daemonMode: false });
    await directFixture.setup();
  });

  afterAll(async () => {
    if (daemonFixture) {
      await daemonFixture.teardown();
    }
    if (directFixture) {
      await directFixture.teardown();
    }
  });

  test("a daemon-forwarded sentinel-encoded duration is revived and rejected as a non-finite number", async () => {
    const { client } = daemonFixture.getContext();

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
    const { client } = daemonFixture.getContext();

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

  // #5919: a DIRECT (non-daemon) client that forges the in-arguments provenance
  // flag must NOT get revival applied. The flag lives in the caller-controllable
  // `arguments` namespace, so a direct client can set it — but revival is gated on
  // `daemonMode`, which the tool caller cannot influence. So a literal sentinel-
  // shaped object it passes stays an object and is rejected as a type mismatch,
  // never decoded to Infinity, restoring #5863's direct-client-isolation intent.
  test("a direct client's FORGED provenance flag does not trigger revival", async () => {
    const { client } = directFixture.getContext();

    const call = client.request(
      {
        method: "tools/call",
        params: {
          name: "tapOn",
          arguments: {
            platform: "android",
            selector: { text: "Gmail" },
            action: "longPress",
            // A direct client forges BOTH the reserved sentinel shape and the
            // provenance flag — exactly the spoof #5919 hardens against.
            duration: { __autoMobileNonFinite__: "Infinity" },
            __autoMobileNonFiniteEncoded: true,
          },
        },
      },
      z.object({}).passthrough(),
    );

    // daemonMode is false → revival is skipped despite the forged flag, so the
    // object is left untouched and rejected as a type mismatch, NOT as a
    // non-finite number.
    await expect(call).rejects.toThrow();
    await expect(call).rejects.not.toThrow(/duration must be a finite number/);
  });
});
