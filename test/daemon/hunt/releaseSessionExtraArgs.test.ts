import { describe, expect, test } from "bun:test";
import { daemonCommandArgumentError } from "../../../src/daemon/cli/runDaemonCommand";

// `--daemon release-session <id> <other-id>` frees only the first session and exits 0; the second
// device stays held for the idle window while the caller believes both were released. The
// lifecycle commands refuse stray words (#11252); the session commands take exactly one id.
describe("session commands take exactly one session id", () => {
  test.each([
    ["release-session", ["session-a", "session-b"]],
    ["session-info", ["session-a", "session-b"]],
    ["release-session", ["session-a", "--jsno"]],
    ["session-info", ["session-a", "--jsno"]],
  ])("%s %j is refused with a usage error", (command, args) => {
    expect(daemonCommandArgumentError(command, args)).toBeDefined();
  });
});
