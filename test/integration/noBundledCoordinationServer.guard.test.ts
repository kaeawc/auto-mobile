import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard: the hand-rolled WebRTC reference coordination server is retired
 * (issue #4291).
 *
 * MediaMTX is now the documented WHIP/WHEP fanout (#4289) and a MediaMTX-backed
 * publisher->WHEP integration test is the safety net (#4290 / PR #4302). The
 * in-process SFU forwarder under `examples/webrtc-coordination-server/` — the
 * largest hand-rolled RTP/PLI surface we owned — is deleted along with its two
 * server-only integration tests.
 *
 * This is a source-scan meta-test (repo convention, cf. #2973/#3081/#3085): it
 * fails HERE, in a fast unit test, if the directory is re-introduced or any
 * tracked file (a dangling import, a stale doc link) points back at it — instead
 * of shipping a broken build or a dead documentation link.
 */
describe("bundled coordination server is retired (issue #4291)", () => {
  const REMOVED_DIR = "examples/webrtc-coordination-server";

  test("the reference coordination server directory is gone", () => {
    expect(existsSync(join(process.cwd(), REMOVED_DIR))).toBe(false);
  });

  test("no tracked file references the removed directory", () => {
    // `git grep` is index-backed and searches only tracked files, so it will not
    // trip on build output or an untracked scratch copy. Exit code 1 means "no
    // matches", which is the success case here.
    const result = spawnSync(
      "git",
      ["grep", "-l", "--", "webrtc-coordination-server", ":!test/integration/noBundledCoordinationServer.guard.test.ts"],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    if (result.error) {
      throw result.error;
    }

    const offenders = result.stdout.split("\n").filter(line => line.length > 0);
    expect(offenders, `these tracked files still reference ${REMOVED_DIR}:\n${offenders.join("\n")}`).toEqual([]);
  });
});
