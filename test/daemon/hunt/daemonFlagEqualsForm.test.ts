import { describe, expect, test } from "bun:test";
import { parseDaemonArgs } from "../../../src/daemon/cli/daemonArgs";
import {
  daemonCommandArgumentError,
  parseResetSlotScopeCommandArgs,
} from "../../../src/daemon/cli/runDaemonCommand";

const log = { warn: () => {} };
type Parsed = ReturnType<typeof parseDaemonArgs>;

// The strict argument validator (#11252) documents that `--flag=value` names `--flag`, so it
// accepts the `=` form of every value flag. The parsers that then consume the same tail only
// match the separate-token form, so the accepted option is dropped without a word.
describe("a --flag=value option the validator accepts must reach the parser", () => {
  test.each([
    ["restart", ["--port=3001"], (o: Parsed) => o.port, 3001],
    ["restart", ["--host=0.0.0.0"], (o: Parsed) => o.host, "0.0.0.0"],
    ["start", ["--video-fps=30"], (o: Parsed) => o.videoFps, 30],
    ["start", ["--enable-tool=observe"], (o: Parsed) => o.enabledTools, ["observe"]],
  ])("%s %j", (command, args, pick, expected) => {
    expect(daemonCommandArgumentError(command, args)).toBeUndefined();
    expect(pick(parseDaemonArgs(args, {}, log))).toEqual(expected);
  });

  const base = ["--runner-namespace", "ns", "--incarnation", "inc"];

  test.each([
    [["--managed-host-scope=hostA"], { managedHostScope: "hostA" }],
    [["--wait-ms=0"], { waitMs: 0 }],
    [["--force=true"], { force: true }],
  ])("reset-slot-scope %j", (extra, expected) => {
    expect(daemonCommandArgumentError("reset-slot-scope", [...base, ...extra])).toBeUndefined();
    expect(parseResetSlotScopeCommandArgs([...base, ...extra])).toMatchObject(expected);
  });
});
