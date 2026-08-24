import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  buildVideoArchiveItemUri,
  VIDEO_RESOURCE_URIS,
} from "../../src/server/videoRecordingResourceUris";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const PREFIX = "automobile:video/archive/";
const recordingId = fc.string({ maxLength: 24 });

describe("buildVideoArchiveItemUri (property-based)", () => {
  test("matches the ARCHIVE_ITEM template with {recordingId} substituted verbatim", () => {
    // Use a function replacement so `$`-patterns in the id are NOT interpreted —
    // the template-literal build appends the id verbatim, and so must the oracle.
    fc.assert(
      fc.property(
        recordingId,
        (id) =>
          buildVideoArchiveItemUri(id) ===
          VIDEO_RESOURCE_URIS.ARCHIVE_ITEM.replace("{recordingId}", () => id),
      ),
      RUN_OPTIONS,
    );
  });

  test("carries the id verbatim after the fixed prefix (round-trip)", () => {
    fc.assert(
      fc.property(recordingId, (id) => {
        const uri = buildVideoArchiveItemUri(id);
        return uri.startsWith(PREFIX) && uri.slice(PREFIX.length) === id;
      }),
      RUN_OPTIONS,
    );
  });

  test("is injective — distinct ids produce distinct uris", () => {
    fc.assert(
      fc.property(
        recordingId,
        recordingId,
        (a, b) => a === b || buildVideoArchiveItemUri(a) !== buildVideoArchiveItemUri(b),
      ),
      RUN_OPTIONS,
    );
  });
});
