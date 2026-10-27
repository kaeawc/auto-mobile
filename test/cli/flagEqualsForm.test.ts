import { beforeAll, describe, expect, test } from "bun:test";
import { parseCliArgs } from "../../src/cli";
import { parseBootDeviceArgs } from "../../src/cli/bootDevice";
import { parseArgs } from "../../src/cli/parseArgs";
import { shouldSkipCtrlProxyDownload } from "../../src/utils/ctrlProxyDownloadControl";
import {
  hasEventAllMarkersCliOverride,
  parseEventAllMarkersConfig,
} from "../../src/utils/eventAllMarkers";
import { parseOutputReductionFlags } from "../../src/utils/outputReductionFlags";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

// CI's per-test time excludes only beforeAll: pay parseCliArgs' one-time tool-schema cost here.
beforeAll(() => {
  parseCliArgs(["observe", "--platform", "android"]);
});

// #11612: `--flag=value` is the same flag as `--flag value` for every reader, not only the
// daemon-command validator.
const warnings: string[] = [];
const log = { warn: (message: string) => warnings.push(message) };
const launch = (args: string[]) => parseArgs(args, log, {});

describe("launcher flags: both forms parse identically", () => {
  test.each([
    ["--port", "3001"],
    ["--host", "0.0.0.0"],
    ["--initial-session-uuid", "abc-123"],
    ["--liveness-owner-token", "tok"],
    ["--a11y-level", "wcag-aa"],
    ["--a11y-failure-mode", "report"],
    ["--a11y-min-severity", "warning"],
    ["--plan-execution-lock-scope", "global"],
    ["--runner-readiness-timeout-ms", "5000"],
    ["--video-quality", "low"],
    ["--video-quality-preset", "low"],
    ["--video-target-bitrate-kbps", "1500"],
    ["--video-max-throughput-mbps", "2.5"],
    ["--video-fps", "24"],
    ["--video-format", "mp4"],
    ["--video-archive-size-mb", "64"],
  ])("%s %s", (flag, value) => {
    const separate = launch([flag, value]);
    const inline = launch([`${flag}=${value}`]);
    expect(inline).toEqual(separate);
    expect(inline).not.toEqual(launch([]));
  });

  test("--a11y-use-baseline accepts bare, =true and =false", () => {
    expect(launch(["--a11y-use-baseline"]).a11yUseBaseline).toBe(true);
    expect(launch(["--a11y-use-baseline=true"]).a11yUseBaseline).toBe(true);
    expect(launch(["--a11y-use-baseline=false"]).a11yUseBaseline).toBe(false);
  });

  test.each(["debug", "strict-port", "no-occlusion", "mem-perf-audit"])(
    "--%s boolean: =true enables, =false does not, =maybe warns and does not",
    (name) => {
      const field = (result: ReturnType<typeof launch>) =>
        Object.entries(result).filter(([, value]) => value === true).length;
      expect(field(launch([`--${name}=true`]))).toBe(field(launch([`--${name}`])));
      expect(field(launch([`--${name}=false`]))).toBe(field(launch([])));
      warnings.length = 0;
      expect(field(launch([`--${name}=maybe`]))).toBe(field(launch([])));
      expect(warnings.join("\n")).toContain(`--${name}`);
    },
  );
});

test("debug flags read the injected environment, not process.env", () => {
  const parsed = parseArgs([], log, { AUTOMOBILE_DEBUG: "1", AUTOMOBILE_DEBUG_PERF: "true" });
  expect(parsed.debug).toBe(true);
  expect(parsed.debugPerf).toBe(true);
  expect(launch([]).debug).toBe(false);
});

describe("shared launcher readers accept both forms", () => {
  test("ctrl-proxy download skip: =true skips, =false overrides the env var", () => {
    const env = { AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD: "1" };
    expect(shouldSkipCtrlProxyDownload(["--skip-ctrl-proxy-download=true"], {})).toBe(true);
    expect(shouldSkipCtrlProxyDownload(["--skip-accessibility-download=true"], {})).toBe(true);
    expect(shouldSkipCtrlProxyDownload(["--skip-ctrl-proxy-download=false"], env)).toBe(false);
    expect(shouldSkipCtrlProxyDownload([], env)).toBe(true);
  });

  test("output reduction flags: =true, =false and the negative compact-metadata flag", () => {
    expect(parseOutputReductionFlags(["--actions-diff-observe=true"], {}).actionsDiffObserve).toBe(
      true,
    );
    expect(
      parseOutputReductionFlags(["--actions-diff-observe=false"], {
        AUTOMOBILE_ACTIONS_DIFF_OBSERVE: "1",
      }).actionsDiffObserve,
    ).toBe(false);
    expect(
      parseOutputReductionFlags(["--actions-compact-metadata=false"], {}).actionsCompactMetadata,
    ).toBe(false);
    expect(
      parseOutputReductionFlags(["--no-actions-compact-metadata=true"], {}).actionsCompactMetadata,
    ).toBe(false);
  });

  test("event-all-markers: inline value, empty override and value containing =", () => {
    expect(parseEventAllMarkersConfig(["--event-all-markers=@,#"], {})).toEqual(["@", "#"]);
    expect(parseEventAllMarkersConfig(["--event-all-markers", "@,#"], {})).toEqual(["@", "#"]);
    expect(hasEventAllMarkersCliOverride(["--event-all-markers="])).toBe(true);
    expect(hasEventAllMarkersCliOverride(["--event-all-markers", "--debug"])).toBe(false);
    expect(parseEventAllMarkersConfig(["--event-all-markers=a=b"], {})).toEqual(["a=b"]);
  });
});

describe("boot-device flags", () => {
  test("--flag=value equals --flag value", () => {
    const separate = parseBootDeviceArgs([
      "--platform",
      "ios",
      "--device-id",
      "UDID",
      "--timeout-ms",
      "300000",
      "--name",
      "iPhone 17",
    ]);
    expect(
      parseBootDeviceArgs([
        "--platform=ios",
        "--device-id=UDID",
        "--timeout-ms=300000",
        "--name=iPhone 17",
      ]),
    ).toEqual(separate);
  });

  test("booleans accept =true/=false and refuse anything else", () => {
    const base = ["--platform=android"];
    expect(parseBootDeviceArgs([...base, "--create-if-missing=true"]).createIfMissing).toBe(true);
    expect(parseBootDeviceArgs([...base, "--create-if-missing=false"]).createIfMissing).toBe(false);
    expect(parseBootDeviceArgs([...base, "--no-prefer-running=true"]).preferRunning).toBe(false);
    expect(parseBootDeviceArgs([...base, "--no-prefer-running=false"]).preferRunning).toBe(true);
    expect(() => parseBootDeviceArgs([...base, "--create-if-missing=maybe"])).toThrow(
      "must be true or false",
    );
  });

  test("an empty or missing value is still an error", () => {
    expect(() => parseBootDeviceArgs(["--platform="])).toThrow("requires a value");
    expect(() => parseBootDeviceArgs(["--platform"])).toThrow("requires a value");
  });
});

describe("tool parameters", () => {
  test("--key=value is the parameter key with that value", () => {
    expect(parseCliArgs(["observe", "--platform=android"]).params).toEqual(
      parseCliArgs(["observe", "--platform", "android"]).params,
    );
  });

  test("a value containing = or starting with -- stays whole", () => {
    expect(parseCliArgs(["observe", "--platform=a=b"]).params.platform).toBe("a=b");
    expect(parseCliArgs(["observe", "--platform=--odd"]).params.platform).toBe("--odd");
  });

  test("a leading --session-uuid=<id> names the session", () => {
    const parsed = parseCliArgs(["--session-uuid=abc", "observe", "--platform", "android"]);
    expect(parsed.sessionUuid).toBe("abc");
    expect(parsed.toolName).toBe("observe");
  });
});
