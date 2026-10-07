import { describe, expect, test } from "bun:test";
import { isConfirmedRecycledProcess } from "../../src/daemon/daemonFiles";
import {
  daemonGenerationMatches,
  darwinProcessGenerationToken,
} from "../../src/daemon/processGeneration";
import {
  processGenerationRecordFields,
  recordedProcessGenerationToken,
} from "../../src/daemon/processGenerationFields";
import { daemonGenerationIdentityFromStatus } from "../../src/daemon/liveAcceptanceCapability";
import {
  LSTART_AMERICA_CHICAGO,
  LSTART_ASIA_TOKYO,
  LSTART_UTC,
  legacyLocalToken,
} from "./psLstartFixtures";

// One real process, printed by `ps` under three zones (see psLstartFixtures.ts).
const UTC_TOKEN = darwinProcessGenerationToken(LSTART_UTC)!;
const CHICAGO_TOKEN = legacyLocalToken(LSTART_AMERICA_CHICAGO);
const TOKYO_TOKEN = legacyLocalToken(LSTART_ASIA_TOKYO);
const LINUX_TOKEN = "linux:2c1d6c0e-3d36-4a89-9d4b-1c5f0e9a6b7e:918273";

/**
 * The PID-record shape older daemon builds read. Those builds' ONLY consumer of a
 * peer's token at daemon startup is `PidFileLiveDaemonSessionIdProvider`
 * (`main:src/daemon/daemonFiles.ts` 704-733, called at 768), reproduced here so the test pins
 * how an OLD reader treats a record THIS build writes:
 *
 *   const recordedToken = pidData.processGenerationToken;          // main:709
 *   if (typeof recordedToken === "string") {                       // main:710
 *     const currentToken = this.readProcessGenerationToken(pid);   // main:712
 *     return typeof currentToken === "string" &&
 *            currentToken !== recordedToken;                       // main:713, STRICT !==
 *   }
 *   ... processStartedAt-only and fully-legacy records: return false  // main:724-732
 *
 * `true` means "pid recycled, skip the peer", which lets the starting daemon
 * expire the peer's active device sessions (`main:src/daemon/daemon.ts` 3578-3590).
 * `false` keeps the peer protected.
 */
function olderBuildJudgesPeerRecycled(
  pidData: Record<string, unknown>,
  ownTokenForLivePid: string | undefined,
): boolean {
  const recordedToken = pidData.processGenerationToken;
  if (typeof recordedToken === "string") {
    return typeof ownTokenForLivePid === "string" && ownTokenForLivePid !== recordedToken;
  }
  return false;
}

/** What a daemon writes for the same peer, minus the token fields. */
const peerRecord = {
  pid: 4242,
  daemonSessionId: "peer-session",
  socketPath: "/tmp/peer.sock",
  port: 3000,
  startedAt: 1_790_000_000_900,
  processStartedAt: 1_790_000_000_400,
  version: "0.0.84",
};

describe("processGenerationRecordFields", () => {
  test("a zone-free Darwin token goes only to the new field", () => {
    const fields = processGenerationRecordFields(UTC_TOKEN);

    expect(fields).toEqual({ processGenerationTokenUtc: UTC_TOKEN });
    expect("processGenerationToken" in fields).toBe(false);
  });

  test("a Linux token keeps the legacy field: its scheme did not change", () => {
    const fields = processGenerationRecordFields(LINUX_TOKEN);

    expect(fields).toEqual({ processGenerationToken: LINUX_TOKEN });
    expect("processGenerationTokenUtc" in fields).toBe(false);
  });

  test("a retired darwin: token echoes back to the legacy field it came from", () => {
    expect(processGenerationRecordFields(CHICAGO_TOKEN)).toEqual({
      processGenerationToken: CHICAGO_TOKEN,
    });
  });

  test("no token publishes no field", () => {
    expect(processGenerationRecordFields(undefined)).toEqual({});
  });
});

describe("recordedProcessGenerationToken", () => {
  test("reads whichever field holds the token", () => {
    expect(recordedProcessGenerationToken({ processGenerationTokenUtc: UTC_TOKEN })).toBe(
      UTC_TOKEN,
    );
    expect(recordedProcessGenerationToken({ processGenerationToken: LINUX_TOKEN })).toBe(
      LINUX_TOKEN,
    );
    expect(recordedProcessGenerationToken({ processGenerationToken: CHICAGO_TOKEN })).toBe(
      CHICAGO_TOKEN,
    );
  });

  test("prefers the zone-free field", () => {
    expect(
      recordedProcessGenerationToken({
        processGenerationToken: CHICAGO_TOKEN,
        processGenerationTokenUtc: UTC_TOKEN,
      }),
    ).toBe(UTC_TOKEN);
  });

  test("a record with no usable token has none", () => {
    expect(recordedProcessGenerationToken({})).toBeUndefined();
    expect(
      recordedProcessGenerationToken({
        processGenerationToken: 7,
        processGenerationTokenUtc: null,
      }),
    ).toBeUndefined();
  });
});

describe("an OLDER build reading a record THIS build writes (issue #10116 review F1)", () => {
  // Under any TZ the older build prints the live peer as `darwin:<its local time>`.
  test.each([
    ["America/Chicago", CHICAGO_TOKEN],
    ["Asia/Tokyo", TOKYO_TOKEN],
  ])(
    "sees no token on a Darwin record and keeps the peer protected (reader in %s)",
    (_zone, own) => {
      const record = { ...peerRecord, ...processGenerationRecordFields(UTC_TOKEN) };

      expect(record).not.toHaveProperty("processGenerationToken");
      expect(olderBuildJudgesPeerRecycled(record, own)).toBe(false);
    },
  );

  test("keeps a Linux peer protected through the unchanged field: equal tokens are not recycled", () => {
    const record = { ...peerRecord, ...processGenerationRecordFields(LINUX_TOKEN) };

    expect(olderBuildJudgesPeerRecycled(record, LINUX_TOKEN)).toBe(false);
    // And a genuinely different Linux generation is still detected by old readers.
    expect(olderBuildJudgesPeerRecycled(record, "linux:2c1d6c0e:1")).toBe(true);
  });

  test("control: the zone-free token under the legacy field is read as a recycled PID (the defect)", () => {
    // What the previous commit did. The older build compares `darwin:<local>`
    // with `darwin-utc:<utc>`, which can never be equal, even with an identical TZ.
    const record = { ...peerRecord, processGenerationToken: UTC_TOKEN };

    expect(olderBuildJudgesPeerRecycled(record, CHICAGO_TOKEN)).toBe(true);
    expect(olderBuildJudgesPeerRecycled(record, legacyLocalToken(LSTART_UTC))).toBe(true);
  });
});

describe("THIS build reading a record an older build wrote (legacy darwin: token)", () => {
  const legacyRecord = { ...peerRecord, processGenerationToken: CHICAGO_TOKEN };

  test("reads the legacy field's token", () => {
    expect(recordedProcessGenerationToken(legacyRecord)).toBe(CHICAGO_TOKEN);
  });

  test("it is incomparable with this build's token for the live PID, so the peer is not judged recycled", () => {
    expect(isConfirmedRecycledProcess(4242, legacyRecord, () => UTC_TOKEN, "test")).toBe(false);
  });

  test("a zone-free record is judged recycled only by a different zone-free token", () => {
    const record = { ...peerRecord, ...processGenerationRecordFields(UTC_TOKEN) };

    expect(isConfirmedRecycledProcess(4242, record, () => UTC_TOKEN, "test")).toBe(false);
    expect(
      isConfirmedRecycledProcess(4242, record, () => "darwin-utc:Tue Oct 6 09:30:00 2026", "test"),
    ).toBe(true);
    expect(isConfirmedRecycledProcess(4242, record, () => CHICAGO_TOKEN, "test")).toBe(false);
  });
});

describe("generation echoes between a client and a daemon", () => {
  const identity = {
    pid: 4242,
    startedAt: 1_790_000_000_900,
    processGenerationToken: UTC_TOKEN,
    version: "0.0.84",
    buildId: "build",
    entryScript: "/repo/dist/src/index.js",
  };
  const claimBase = {
    pid: identity.pid,
    startedAt: identity.startedAt,
    version: identity.version,
    buildId: identity.buildId,
    entryScript: identity.entryScript,
  };

  test("a client echoing the zone-free field matches the daemon", () => {
    expect(
      daemonGenerationMatches(identity, {
        ...claimBase,
        ...processGenerationRecordFields(UTC_TOKEN),
      }),
    ).toBe(true);
  });

  test("a client echoing a different zone-free token does not match", () => {
    expect(
      daemonGenerationMatches(identity, {
        ...claimBase,
        processGenerationTokenUtc: "darwin-utc:Tue Oct 6 09:30:00 2026",
      }),
    ).toBe(false);
  });

  test("an older client, which sees no token for this daemon, echoes none and still matches on the tuple", () => {
    expect(daemonGenerationMatches(identity, claimBase)).toBe(true);
  });

  test("the acceptance identity carries the token from either record field", () => {
    const status = {
      pid: 4242,
      startedAt: 1,
      version: "0.0.84",
      buildId: "build",
      entryScript: "/repo/dist/src/index.js",
    };

    expect(
      daemonGenerationIdentityFromStatus({ ...status, processGenerationTokenUtc: UTC_TOKEN }),
    ).toMatchObject({ processGenerationToken: UTC_TOKEN });
    expect(
      daemonGenerationIdentityFromStatus({ ...status, processGenerationToken: LINUX_TOKEN }),
    ).toMatchObject({ processGenerationToken: LINUX_TOKEN });
    expect(daemonGenerationIdentityFromStatus(status)).not.toHaveProperty("processGenerationToken");
  });
});
