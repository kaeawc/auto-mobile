import { describe, expect, test } from "bun:test";
import {
  DefaultCtrlProxyCodesignVerifier,
  parseTeamIdentifier,
  type CodesignExec,
  type CodesignExecOutput
} from "../../src/utils/ios-cmdline-tools/CtrlProxyCodesignVerifier";
import * as path from "path";

/** Records every invocation and replays scripted outputs keyed by the tool + first flag. */
function scriptedExec(
  responses: Record<string, CodesignExecOutput>
): { exec: CodesignExec; calls: Array<{ file: string; args: readonly string[] }> } {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const exec: CodesignExec = async (file, args) => {
    calls.push({ file, args });
    const key = `${file} ${args[0]}`;
    return responses[key] ?? { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const APP = path.join("Build", "Products", "Debug-iphonesimulator", "CtrlProxyUITests-Runner.app");

describe("parseTeamIdentifier", function() {
  test("extracts the Team ID from codesign -dvv stderr", function() {
    const output = [
      "Executable=/x/CtrlProxyUITests-Runner",
      "Identifier=com.example.runner",
      "TeamIdentifier=ABCDE12345",
      "Sealed Resources version=2",
    ].join("\n");
    expect(parseTeamIdentifier(output)).toBe("ABCDE12345");
  });

  test("returns null for an ad-hoc / unsigned bundle", function() {
    expect(parseTeamIdentifier("TeamIdentifier=not set")).toBeNull();
    expect(parseTeamIdentifier("no team here")).toBeNull();
  });
});

describe("DefaultCtrlProxyCodesignVerifier", function() {
  test("reports verified + notarized + team id when all commands exit 0", async function() {
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

  test("reports verify failure with detail and non-notarized when codesign/spctl exit non-zero", async function() {
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
