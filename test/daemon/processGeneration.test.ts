import { describe, expect, test } from "bun:test";
import { isConfirmedRecycledProcess } from "../../src/daemon/daemonFiles";
import { DARWIN_PROCESS_TABLE_COMMAND, PsDaemonProcessFinder } from "../../src/daemon/processTable";
import {
  compareProcessGenerationTokens,
  createCurrentProcessGenerationTokenProvider,
  createLinuxProcessGenerationTokenReader,
  daemonGenerationMatches,
  darwinProcessGenerationToken,
  readDarwinProcessGenerationToken,
} from "../../src/daemon/processGeneration";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  CAPTURED_START_EPOCH_MS,
  LSTART_AMERICA_CHICAGO,
  LSTART_ASIA_TOKYO,
  LSTART_UTC,
  capturedLstartFor,
  legacyLocalToken,
  renderLstart,
} from "./psLstartFixtures";

describe("daemon generation matching", () => {
  const generation = {
    pid: 42,
    startedAt: 1_000,
    processGenerationToken: "linux:boot-id:424242",
    version: "0.0.73",
    buildId: "current-build",
    entryScript: "/current/dist/src/index.js",
  };

  test("accepts the current generation token and complete identity tuple", () => {
    expect(daemonGenerationMatches(generation, generation)).toBe(true);
  });

  test("accepts a legacy omitted token only when the complete identity tuple matches", () => {
    const legacyGeneration = {
      pid: generation.pid,
      startedAt: generation.startedAt,
      version: generation.version,
      buildId: generation.buildId,
      entryScript: generation.entryScript,
    };

    expect(daemonGenerationMatches(generation, legacyGeneration)).toBe(true);
  });

  test("rejects a legacy omitted token when the identity tuple is stale", () => {
    const staleLegacyGeneration = {
      pid: generation.pid,
      startedAt: generation.startedAt - 1,
      version: generation.version,
      buildId: generation.buildId,
      entryScript: generation.entryScript,
    };

    expect(daemonGenerationMatches(generation, staleLegacyGeneration)).toBe(false);
  });

  test("rejects a supplied token mismatch even when the legacy identity tuple matches", () => {
    expect(
      daemonGenerationMatches(generation, {
        ...generation,
        processGenerationToken: "linux:attacker-controlled:424242",
      }),
    ).toBe(false);
  });
});

describe("current daemon process generation tokens", () => {
  test("captures the Linux token directly once and caches it for later Daemon construction", () => {
    const readPaths: string[] = [];
    const readLinux = createLinuxProcessGenerationTokenReader((path) => {
      readPaths.push(path);
      return path === "/proc/42/stat"
        ? `42 (auto-mobile) ${["S", ...Array(18).fill("0"), "424242"].join(" ")}`
        : "boot-id";
    });
    let reads = 0;
    const provider = createCurrentProcessGenerationTokenProvider({
      platform: "linux",
      pid: 42,
      readLinuxProcessGenerationToken: (pid) => {
        reads++;
        return readLinux(pid);
      },
    });

    expect(provider()).toBe("linux:boot-id:424242");
    expect(provider()).toBe("linux:boot-id:424242");
    expect(reads).toBe(1);
    expect(readPaths).toEqual(["/proc/42/stat", "/proc/sys/kernel/random/boot_id"]);
  });

  test("uses a direct, locale-stable Darwin single-PID query", () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: { timeout: number; env: NodeJS.ProcessEnv };
    }> = [];

    expect(
      readDarwinProcessGenerationToken(42, (command, args, options) => {
        calls.push({ command, args, options });
        return "Sun Nov 1 01:30:00 2026\n";
      }),
    ).toBe("darwin-utc:Sun Nov 1 01:30:00 2026");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "ps",
      args: ["-p", "42", "-o", "lstart="],
      options: { timeout: 1_000, env: { LC_ALL: "C", TZ: "UTC" } },
    });
  });

  describe("Darwin token is independent of the reader's time zone (issue #10116)", () => {
    const HOST_ZONE = "America/Chicago";
    /** A `ps` that renders the captured process's lstart in the zone its env names. */
    const capturedPs = (
      _command: string,
      _args: readonly string[],
      options: { env: NodeJS.ProcessEnv },
    ): string => capturedLstartFor(options.env.TZ, HOST_ZONE);
    const EXPECTED_TOKEN = "darwin-utc:Tue Oct 6 07:35:51 2026";

    test("the captured fixtures are one instant printed in three zones", () => {
      // This is the defect: the same live process prints a different string per TZ.
      expect(new Set([LSTART_UTC, LSTART_AMERICA_CHICAGO, LSTART_ASIA_TOKYO]).size).toBe(3);
      expect(renderLstart(CAPTURED_START_EPOCH_MS, "UTC")).toBe(LSTART_UTC.trimEnd());
      expect(renderLstart(CAPTURED_START_EPOCH_MS, "America/Chicago")).toBe(
        LSTART_AMERICA_CHICAGO.trimEnd(),
      );
      expect(renderLstart(CAPTURED_START_EPOCH_MS, "Asia/Tokyo")).toBe(LSTART_ASIA_TOKYO.trimEnd());
    });

    test("pins TZ=UTC and LC_ALL=C in the environment handed to ps", () => {
      const seenEnvs: NodeJS.ProcessEnv[] = [];
      readDarwinProcessGenerationToken(42, (command, args, options) => {
        seenEnvs.push(options.env);
        return capturedPs(command, args, options);
      });

      expect(seenEnvs).toHaveLength(1);
      expect(seenEnvs[0]?.TZ).toBe("UTC");
      expect(seenEnvs[0]?.LC_ALL).toBe("C");
    });

    test("the token is the UTC rendering of the captured process, not the local one", () => {
      expect(readDarwinProcessGenerationToken(42, capturedPs)).toBe(EXPECTED_TOKEN);
      expect(darwinProcessGenerationToken(LSTART_UTC)).toBe(EXPECTED_TOKEN);
      // Without the pin the same read would have produced the host-local string.
      expect(legacyLocalToken(LSTART_AMERICA_CHICAGO)).not.toBe(EXPECTED_TOKEN);
    });

    test.each(["America/Chicago", "Asia/Tokyo", "UTC", "Pacific/Auckland"])(
      "a daemon and a CLI whose hosts are in %s read the same token for one process",
      (hostZone) => {
        const hostPs = (
          _command: string,
          _args: readonly string[],
          options: { env: NodeJS.ProcessEnv },
        ): string => renderLstart(CAPTURED_START_EPOCH_MS, options.env.TZ ?? hostZone);

        expect(readDarwinProcessGenerationToken(42, hostPs)).toBe(EXPECTED_TOKEN);
      },
    );

    test("the process-table scan and the single-PID read agree for one process", () => {
      const finder = new PsDaemonProcessFinder(
        (command) => {
          const zone = /\bTZ=(\S+)/.exec(command)?.[1];
          return `20 1 ${capturedLstartFor(zone, HOST_ZONE).trim()} bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode`;
        },
        "darwin",
        new FakeTimer(),
      );

      const [record] = finder.findDaemonProcesses();

      expect(record?.processGenerationToken).toBe(EXPECTED_TOKEN);
      expect(record?.processGenerationToken).toBe(readDarwinProcessGenerationToken(20, capturedPs));
      expect(record?.startedAt).toBe(CAPTURED_START_EPOCH_MS);
    });

    test("the scan command pins the same environment", () => {
      expect(DARWIN_PROCESS_TABLE_COMMAND).toBe(
        "LC_ALL=C TZ=UTC ps -axo pid=,ppid=,lstart=,command=",
      );
    });

    describe("around a daylight-saving fall-back", () => {
      // 2026-11-01 01:30 happens twice in Chicago: 06:30Z (CDT) and 07:30Z (CST).
      const FIRST_PASS = Date.UTC(2026, 10, 1, 6, 30, 0);
      const SECOND_PASS = Date.UTC(2026, 10, 1, 7, 30, 0);
      const readAt = (epochMs: number): string | undefined =>
        readDarwinProcessGenerationToken(42, (_command, _args, options) =>
          renderLstart(epochMs, options.env.TZ ?? HOST_ZONE),
        );

      test("local wall time cannot tell the two passes apart, the UTC token can", () => {
        expect(renderLstart(FIRST_PASS, HOST_ZONE)).toBe(renderLstart(SECOND_PASS, HOST_ZONE));
        expect(readAt(FIRST_PASS)).not.toBe(readAt(SECOND_PASS));
      });

      test("a process started an hour later in the repeated hour is a different generation", () => {
        const recorded = readAt(FIRST_PASS)!;
        const live = readAt(SECOND_PASS)!;

        expect(compareProcessGenerationTokens(recorded, live)).toBe("different");
        expect(
          isConfirmedRecycledProcess(42, { processGenerationToken: recorded }, () => live, "test"),
        ).toBe(true);
      });

      test("one process keeps one token wherever and whenever it is read", () => {
        expect(readAt(FIRST_PASS)).toBe(readAt(FIRST_PASS));
        expect(readAt(FIRST_PASS)).toBe("darwin-utc:Sun Nov 1 06:30:00 2026");
      });
    });

    describe("a record written by an older build (local-time token)", () => {
      const OLD_TOKEN = legacyLocalToken(LSTART_AMERICA_CHICAGO);

      test("is incomparable to the live token, never a mismatch", () => {
        expect(OLD_TOKEN).toBe("darwin:Tue Oct 6 02:35:51 2026");
        expect(compareProcessGenerationTokens(OLD_TOKEN, EXPECTED_TOKEN)).toBe("incomparable");
        expect(compareProcessGenerationTokens(EXPECTED_TOKEN, OLD_TOKEN)).toBe("incomparable");
      });

      test("never marks a live daemon recycled, whichever zone wrote or reads it", () => {
        for (const legacy of [LSTART_AMERICA_CHICAGO, LSTART_ASIA_TOKYO, LSTART_UTC]) {
          expect(
            isConfirmedRecycledProcess(
              42,
              { processGenerationToken: legacyLocalToken(legacy) },
              () => readDarwinProcessGenerationToken(42, capturedPs),
              "test",
            ),
          ).toBe(false);
        }
      });
    });
  });

  describe("compareProcessGenerationTokens", () => {
    test("equal tokens are the same, whatever the scheme", () => {
      expect(
        compareProcessGenerationTokens(
          "darwin:Sun Nov 1 01:30:00 2026",
          "darwin:Sun Nov 1 01:30:00 2026",
        ),
      ).toBe("same");
      expect(compareProcessGenerationTokens("linux:boot:1", "linux:boot:1")).toBe("same");
    });

    test("unequal tokens of the same current scheme are different", () => {
      expect(
        compareProcessGenerationTokens(
          "darwin-utc:Tue Oct 6 04:04:21 2026",
          "darwin-utc:Tue Oct 6 04:04:22 2026",
        ),
      ).toBe("different");
      expect(compareProcessGenerationTokens("linux:boot:1", "linux:boot:2")).toBe("different");
    });

    test("a record from an older build is never comparable to a current token", () => {
      // The old `darwin:` token is local wall time; the same process reads as
      // `darwin-utc:` now, so a mismatch is not evidence of a different process.
      expect(
        compareProcessGenerationTokens(
          "darwin:Mon Oct 5 23:04:21 2026",
          "darwin-utc:Tue Oct 6 04:04:21 2026",
        ),
      ).toBe("incomparable");
      expect(
        compareProcessGenerationTokens(
          "darwin-utc:Tue Oct 6 04:04:21 2026",
          "darwin:Mon Oct 5 23:04:21 2026",
        ),
      ).toBe("incomparable");
    });

    test("two unequal legacy darwin tokens are never proof (time zone dependent)", () => {
      expect(
        compareProcessGenerationTokens(
          "darwin:Mon Oct 5 23:04:21 2026",
          "darwin:Tue Oct 6 04:04:21 2026",
        ),
      ).toBe("incomparable");
    });

    test("tokens from different platforms are incomparable", () => {
      expect(
        compareProcessGenerationTokens("linux:boot:1", "darwin-utc:Tue Oct 6 04:04:21 2026"),
      ).toBe("incomparable");
    });
  });

  test("preserves Windows' optional-token behavior without an OS read", () => {
    let reads = 0;
    const provider = createCurrentProcessGenerationTokenProvider({
      platform: "win32",
      readLinuxProcessGenerationToken: () => {
        reads++;
        return "linux:boot:1";
      },
      readDarwinProcessGenerationToken: () => {
        reads++;
        return "darwin:Sun Nov 1 01:30:00 2026";
      },
    });

    expect(provider()).toBeUndefined();
    expect(provider()).toBeUndefined();
    expect(reads).toBe(0);
  });

  test("fails closed and caches an unavailable direct capture", () => {
    let reads = 0;
    const provider = createCurrentProcessGenerationTokenProvider({
      platform: "linux",
      readLinuxProcessGenerationToken: () => {
        reads++;
        throw new Error("procfs unavailable");
      },
    });

    expect(provider()).toBeUndefined();
    expect(provider()).toBeUndefined();
    expect(reads).toBe(1);
  });
});
