import { describe, expect, test } from "bun:test";
import { isConfirmedRecycledProcess } from "../../src/daemon/daemonFiles";
import { darwinProcessGenerationToken } from "../../src/daemon/processGeneration";
import { PsDaemonProcessFinder } from "../../src/daemon/processTable";
import {
  LSTART_AMERICA_CHICAGO,
  LSTART_ASIA_TOKYO,
  LSTART_UTC,
  legacyLocalToken,
} from "./psLstartFixtures";

// One real process, printed by `ps` under three zones (see psLstartFixtures.ts).
const UTC_TOKEN = darwinProcessGenerationToken(LSTART_UTC)!;
const LOCAL_TOKEN = legacyLocalToken(LSTART_AMERICA_CHICAGO);
const TOKYO_LOCAL_TOKEN = legacyLocalToken(LSTART_ASIA_TOKYO);

/**
 * A PID record is proof its daemon exited only when its recorded generation
 * token differs from a token actually read from the live PID (issue #10108).
 * Every uncertain input must answer false.
 */
describe("isConfirmedRecycledProcess (issue #10108)", () => {
  test("a differing live token confirms the PID was recycled", () => {
    expect(
      isConfirmedRecycledProcess(
        10,
        { processGenerationToken: "generation-1" },
        () => "generation-2",
        "test",
      ),
    ).toBe(true);
  });

  test("a different current-scheme darwin token is proof of recycling", () => {
    expect(
      isConfirmedRecycledProcess(
        10,
        { processGenerationTokenUtc: UTC_TOKEN },
        () => "darwin-utc:Tue Oct 6 09:30:00 2026",
        "test",
      ),
    ).toBe(true);
  });

  test("a record written by an older build is never judged recycled (live token in the new scheme)", () => {
    expect(
      isConfirmedRecycledProcess(
        10,
        { processGenerationToken: LOCAL_TOKEN },
        () => UTC_TOKEN,
        "test",
      ),
    ).toBe(false);
  });

  test("a current-scheme record is never judged recycled against an old-scheme live token", () => {
    expect(
      isConfirmedRecycledProcess(
        10,
        { processGenerationTokenUtc: UTC_TOKEN },
        () => LOCAL_TOKEN,
        "test",
      ),
    ).toBe(false);
  });

  test("two different legacy darwin tokens are never proof (they depend on the zone)", () => {
    expect(
      isConfirmedRecycledProcess(
        10,
        { processGenerationToken: LOCAL_TOKEN },
        () => TOKYO_LOCAL_TOKEN,
        "test",
      ),
    ).toBe(false);
  });

  test("the same live token is the recorded process", () => {
    expect(
      isConfirmedRecycledProcess(
        10,
        { processGenerationToken: "generation-1" },
        () => "generation-1",
        "test",
      ),
    ).toBe(false);
  });

  test("an unreadable live token is never proof", () => {
    expect(
      isConfirmedRecycledProcess(
        10,
        { processGenerationToken: "generation-1" },
        () => undefined,
        "test",
      ),
    ).toBe(false);
  });

  test("a throwing reader is never proof", () => {
    expect(
      isConfirmedRecycledProcess(
        10,
        { processGenerationToken: "generation-1" },
        () => {
          throw new Error("ps timed out");
        },
        "test",
      ),
    ).toBe(false);
  });

  test("a record without a token is never read against the live PID", () => {
    let reads = 0;
    const recycled = isConfirmedRecycledProcess(
      10,
      {},
      () => {
        reads += 1;
        return "generation-2";
      },
      "test",
    );

    expect(recycled).toBe(false);
    expect(reads).toBe(0);
  });
});

describe("PsDaemonProcessFinder.readProcessGenerationToken", () => {
  test("reads the live PID's token from /proc on linux", () => {
    const finder = new PsDaemonProcessFinder(
      undefined,
      "linux",
      undefined,
      (pid) => `linux:boot:${pid}`,
    );

    expect(finder.readProcessGenerationToken(42)).toBe("linux:boot:42");
  });

  test("has no token source on an unsupported platform", () => {
    const finder = new PsDaemonProcessFinder(undefined, "freebsd", undefined, () => "never-read");

    expect(finder.readProcessGenerationToken(42)).toBeUndefined();
  });
});
