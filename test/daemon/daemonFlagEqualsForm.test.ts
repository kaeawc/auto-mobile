import { describe, expect, test } from "bun:test";
import {
  DAEMON_LAUNCH_BOOLEAN_FLAGS,
  DAEMON_LAUNCH_VALUE_FLAGS,
  parseDaemonArgs,
} from "../../src/daemon/cli/daemonArgs";
import { daemonCommandArgumentError } from "../../src/daemon/cli/runDaemonCommand";

const warnings: string[] = [];
const log = { warn: (message: string) => warnings.push(message) };
type Parsed = ReturnType<typeof parseDaemonArgs>;

// The strict argument validator (#11252) documents that `--flag=value` names `--flag`, so it
// accepts the `=` form of every value flag. The parsers that then consume the same tail only
// matched the separate-token form, so the accepted option was dropped without a word (#11612).
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
});

// A sample operand per value flag. A flag added to the daemon surface without a sample fails the
// coverage test below, so the table cannot silently stop covering the documented flags.
const VALUE_SAMPLES: Record<string, string> = {
  "--port": "3001",
  "--host": "0.0.0.0",
  "--plan-execution-lock-scope": "global",
  "--runner-readiness-timeout-ms": "5000",
  "--tool-outputs-dir": "/tmp/tool-outputs",
  "--tool-output-dir": "/tmp/tool-outputs",
  "--enable-tool": "observe",
  "--disable-tool": "tapOn",
  "--video-target-bitrate-kbps": "1500",
  "--video-max-throughput-mbps": "2.5",
  "--video-fps": "24",
  "--video-archive-size-mb": "64",
  "--video-quality": "low",
  "--video-quality-preset": "low",
  "--video-format": "mp4",
  "--accessibility-level": "wcag-aa",
  "--a11y-level": "wcag-aa",
  "--accessibility-failure-mode": "report",
  "--a11y-failure-mode": "report",
  "--accessibility-min-severity": "warning",
  "--a11y-min-severity": "warning",
  "--event-all-markers": "@,#",
  "--daemon-socket-path": "/tmp/x.sock",
};

describe("every documented daemon flag parses identically in both forms", () => {
  test("the sample table covers exactly the value flags the daemon accepts", () => {
    expect(Object.keys(VALUE_SAMPLES).sort()).toEqual([...DAEMON_LAUNCH_VALUE_FLAGS].sort());
  });

  test.each(Object.entries(VALUE_SAMPLES))("%s %s", (flag, value) => {
    const separate = parseDaemonArgs([flag, value], {}, log);
    const inline = parseDaemonArgs([`${flag}=${value}`], {}, log);
    expect(inline).toEqual(separate);
    expect(daemonCommandArgumentError("start", [flag, value])).toBeUndefined();
    expect(daemonCommandArgumentError("start", [`${flag}=${value}`])).toBeUndefined();
  });

  test("the value flags that set an option do set it", () => {
    for (const flag of ["--port", "--host", "--video-fps", "--enable-tool", "--a11y-level"]) {
      expect(parseDaemonArgs([`${flag}=${VALUE_SAMPLES[flag]}`], {}, log)).not.toEqual(
        parseDaemonArgs([], {}, log),
      );
    }
  });

  const booleanFlags = [...DAEMON_LAUNCH_BOOLEAN_FLAGS];

  test.each(booleanFlags)(
    "%s: bare and =true agree, =false never enables, =maybe is refused",
    (flag) => {
      const bare = parseDaemonArgs([flag], {}, log);
      expect(parseDaemonArgs([`${flag}=true`], {}, log)).toEqual(bare);
      const off = parseDaemonArgs([`${flag}=false`], {}, log);
      expect(Object.values(off)).not.toContain(true);
      expect(daemonCommandArgumentError("start", [flag])).toBeUndefined();
      expect(daemonCommandArgumentError("start", [`${flag}=true`])).toBeUndefined();
      expect(daemonCommandArgumentError("start", [`${flag}=false`])).toBeUndefined();
      expect(daemonCommandArgumentError("start", [`${flag}=maybe`])).toContain(
        "expected true or false",
      );
    },
  );

  test("a boolean flag never consumes the word after it", () => {
    expect(daemonCommandArgumentError("start", ["--debug", "extra"])).toContain("Unexpected");
  });
});

describe("value shape", () => {
  test("a value containing = is kept whole", () => {
    expect(parseDaemonArgs(["--host=a=b=c"], {}, log).host).toBe("a=b=c");
    expect(parseDaemonArgs(["--tool-outputs-dir=/tmp/a=b"], {}, log).toolOutputsDir).toBe(
      "/tmp/a=b",
    );
  });

  test("an inline value that starts with -- is a value, a separate one is the next flag", () => {
    expect(parseDaemonArgs(["--host=--weird"], {}, log).host).toBe("--weird");
    expect(parseDaemonArgs(["--host", "--debug"], {}, log)).toMatchObject({ debug: true });
    expect(parseDaemonArgs(["--host", "--debug"], {}, log).host).toBeUndefined();
  });

  test("repeated tool flags accumulate in either form and the last scalar wins", () => {
    const parsed = parseDaemonArgs(
      ["--enable-tool=a", "--enable-tool", "b", "--video-fps=10", "--video-fps", "20"],
      {},
      log,
    );
    expect(parsed.enabledTools).toEqual(["a", "b"]);
    expect(parsed.videoFps).toBe(20);
  });

  test("a bare -- ends the options", () => {
    expect(parseDaemonArgs(["--", "--port=3001"], {}, log).port).toBeUndefined();
    expect(daemonCommandArgumentError("start", ["--", "--port=3001"])).toContain("Unexpected");
  });

  test("an invalid inline value is warned about, not dropped silently", () => {
    warnings.length = 0;
    expect(
      parseDaemonArgs(["--plan-execution-lock-scope=bogus"], {}, log).planExecutionLockScope,
    ).toBeUndefined();
    expect(warnings.join("\n")).toContain("--plan-execution-lock-scope");
  });
});
