import { describe, test } from "bun:test";
import fc from "fast-check";
import { resolveImageBackend } from "../../../../src/utils/image/backend/resolveImageBackend";
import { JimpBackend } from "../../../../src/utils/image/backend/JimpBackend";
import { JimpCliBackend } from "../../../../src/utils/image/backend/JimpCliBackend";
import { SharpBackend } from "../../../../src/utils/image/backend/SharpBackend";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const KNOWN_PLATFORMS: NodeJS.Platform[] = [
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
  "netbsd",
];
const knownPlatform = fc.constantFrom(...KNOWN_PLATFORMS);
const nonPrimary = fc.constantFrom(
  ...KNOWN_PLATFORMS.filter((p) => p !== "win32" && p !== "darwin" && p !== "linux"),
);

describe("resolveImageBackend (property-based)", () => {
  test("dispatches each platform to the documented backend", () => {
    fc.assert(
      fc.property(knownPlatform, (platform) => {
        const backend = resolveImageBackend({ platform });
        if (platform === "win32") {
          return backend instanceof JimpCliBackend;
        }
        if (platform === "darwin" || platform === "linux") {
          return backend instanceof SharpBackend;
        }
        return backend instanceof JimpBackend;
      }),
      RUN_OPTIONS,
    );
  });

  test("is total — returns an ImageBackend object for any platform string, never throwing", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 10 }), (s) => {
        const backend = resolveImageBackend({ platform: s as NodeJS.Platform });
        // The property completing without throwing IS the totality check; the
        // return type is non-nullable, so assert only that it is an object.
        return typeof backend === "object";
      }),
      RUN_OPTIONS,
    );
  });

  test("every non-primary platform falls back to the jimp backend", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          nonPrimary,
          fc.string({ maxLength: 8 }).map((s) => `${s}x` as NodeJS.Platform),
        ),
        (platform) => {
          return resolveImageBackend({ platform }) instanceof JimpBackend;
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("is deterministic — the same platform resolves to the same backend class", () => {
    fc.assert(
      fc.property(knownPlatform, (platform) => {
        const a = resolveImageBackend({ platform });
        const b = resolveImageBackend({ platform });
        return a.constructor === b.constructor;
      }),
      RUN_OPTIONS,
    );
  });
});
