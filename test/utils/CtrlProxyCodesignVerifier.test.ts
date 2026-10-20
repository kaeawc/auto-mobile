import { describe, expect, test } from "bun:test";
import {
  DefaultCtrlProxyCodesignVerifier,
  createCodesignExec,
  parseTeamIdentifier,
  type CodesignExec,
  type CodesignExecOutput,
} from "../../src/utils/ios-cmdline-tools/CtrlProxyCodesignVerifier";
import { FakeTimer } from "../fakes/FakeTimer";
import * as path from "path";

/** Records every invocation and replays scripted outputs keyed by the tool + first flag. */
function scriptedExec(responses: Record<string, CodesignExecOutput>): {
  exec: CodesignExec;
  calls: Array<{ file: string; args: readonly string[] }>;
} {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const exec: CodesignExec = async (file, args) => {
    calls.push({ file, args });
    const key = `${file} ${args[0]}`;
    return responses[key] ?? { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const APP = path.join("Build", "Products", "Debug-iphonesimulator", "CtrlProxyUITests-Runner.app");

describe("parseTeamIdentifier", function () {
  test("extracts the Team ID from codesign -dvv stderr", function () {
    const output = [
      "Executable=/x/CtrlProxyUITests-Runner",
      "Identifier=com.example.runner",
      "TeamIdentifier=ABCDE12345",
      "Sealed Resources version=2",
    ].join("\n");
    expect(parseTeamIdentifier(output)).toBe("ABCDE12345");
  });

  test("returns null for an ad-hoc / unsigned bundle", function () {
    expect(parseTeamIdentifier("TeamIdentifier=not set")).toBeNull();
    expect(parseTeamIdentifier("no team here")).toBeNull();
  });
});

describe("DefaultCtrlProxyCodesignVerifier", function () {
  test("reports verified + notarized + team id when all commands exit 0", async function () {
    const { exec, calls } = scriptedExec({
      "codesign --verify": { code: 0, stdout: "", stderr: "" },
      "codesign -dvv": { code: 0, stdout: "", stderr: "TeamIdentifier=ABCDE12345\n" },
      "spctl --assess": { code: 0, stdout: "", stderr: "" },
    });
    const outcome = await new DefaultCtrlProxyCodesignVerifier(exec).verifyAppBundle(APP);

    expect(outcome).toEqual({ verified: true, notarized: true, teamId: "ABCDE12345", detail: "" });
    // The app path is passed as one literal argument, never interpolated.
    expect(calls[0].args).toContain(APP);
  });

  test("bounds all three exec calls with the configured timeoutMs", async () => {
    const timeouts: number[] = [];
    const exec: CodesignExec = async (_file, _args, options) => {
      timeouts.push(options?.timeoutMs);
      return { code: 0, stdout: "", stderr: "" };
    };
    await new DefaultCtrlProxyCodesignVerifier(exec, new FakeTimer()).verifyAppBundle(APP);
    expect(timeouts).toEqual([15_000, 15_000, 15_000]);
  });

  test.each(["--verify", "-dvv", "--assess"])(
    "bounds a hung %s command with FakeTimer",
    async (flag) => {
      const timer = new FakeTimer();
      const exec: CodesignExec = async (_file, args) =>
        args[0] === flag
          ? new Promise<CodesignExecOutput>(() => {})
          : { code: 0, stdout: "", stderr: "" };
      const checking = new DefaultCtrlProxyCodesignVerifier(exec, timer).verifyAppBundle(APP);
      // Drain preceding successful commands before inspecting the hung command's deadline.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(timer.getPendingTimeouts()).toEqual([15_000]);
      const failure = checking.then(
        () => undefined,
        (error: unknown) => error,
      );
      timer.advanceTime(15_000);
      const error = await failure;
      if (!(error instanceof Error)) {
        throw new Error("Hung command did not reject with a timeout error");
      }
      expect(error.message).toContain(`${flag} timed out after 15000ms`);
      expect(timer.now()).toBe(15_000);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("reports verify failure with detail and non-notarized when codesign/spctl exit non-zero", async function () {
    const { exec } = scriptedExec({
      "codesign --verify": { code: 1, stdout: "", stderr: "code object is not signed at all" },
      "codesign -dvv": { code: 1, stdout: "", stderr: "TeamIdentifier=not set\n" },
      "spctl --assess": { code: 3, stdout: "", stderr: "rejected" },
    });
    const outcome = await new DefaultCtrlProxyCodesignVerifier(exec).verifyAppBundle(APP);

    expect(outcome.verified).toBe(false);
    expect(outcome.notarized).toBe(false);
    expect(outcome.teamId).toBeNull();
    expect(outcome.detail).toContain("not signed at all");
    expect(outcome.detail).toContain("rejected");
  });
});

describe("production codesign exec error mapping", () => {
  test.each([
    { label: "elapsed timeout", code: null, elapsed: 15_000, timedOut: true },
    { label: "explicit timeout", code: "ETIMEDOUT", elapsed: 0, timedOut: true },
    {
      label: "output overflow",
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      elapsed: 0,
      timedOut: false,
    },
    {
      label: "overflow at deadline",
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      elapsed: 15_000,
      timedOut: false,
    },
  ])("maps $label without invoking a native tool", async ({ code, elapsed, timedOut }) => {
    const timer = new FakeTimer();
    const exec = createCodesignExec(async (_file, _args, options) => {
      expect(options).toEqual({ timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
      timer.advanceTime(elapsed);
      throw Object.assign(new Error("exec failed"), {
        code,
        killed: true,
        signal: "SIGTERM",
        stdout: "partial",
        stderr: "diagnostic",
      });
    }, timer);
    const checking = exec("codesign", ["--verify", APP], { timeoutMs: 15_000 });
    if (timedOut) {
      await expect(checking).rejects.toThrow("codesign --verify timed out after 15000ms");
    } else {
      expect(await checking).toEqual({ code: 1, stdout: "partial", stderr: "diagnostic" });
    }
  });
});
