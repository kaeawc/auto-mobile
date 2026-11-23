import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OsascriptSimulatorRenderOverlayControl,
  parseRenderOverlayOutput,
} from "../../../src/utils/ios-cmdline-tools/SimulatorRenderOverlays";
import { ActionableError } from "../../../src/models/ActionableError";
import type { HostCommandExecutor } from "../../../src/utils/HostCommandExecutor";
import { createExecResult } from "../../../src/utils/execResult";

const FIXTURES = join(import.meta.dir, "../../fixtures/ios-render-overlays");
const UDID = "E5D28852-ACC5-4769-91DA-7F497C8969B9";

/** Captured from an iOS 27.2 Simulator (Xcode 27.2) turning on blended layers and off-screen. */
const DEVELOPER_DIR = async () => "/Applications/Xcode.app/Contents/Developer";
const SET_STDOUT = readFileSync(join(FIXTURES, "set-blended-offscreen.stdout"), "utf8");
/** Captured osascript stderr for a UDID that is not in the default device set. */
const MISSING_STDERR = readFileSync(join(FIXTURES, "missing-device.stderr"), "utf8");

class RecordingHost implements HostCommandExecutor {
  readonly calls: Array<{ file: string; args: string[] }> = [];
  constructor(private readonly outcome: { stdout?: string; error?: Error }) {}

  async executeCommand(file: string, args: string[] = []) {
    this.calls.push({ file, args });
    if (this.outcome.error) {
      throw this.outcome.error;
    }
    return createExecResult(this.outcome.stdout ?? "", "");
  }
}

describe("CoreSimulator render overlay bridge (#19016)", () => {
  test("maps the captured option-id state to overlay names", () => {
    expect(parseRenderOverlayOutput(SET_STDOUT)).toEqual({
      previous: {
        flashUpdatedRegions: false,
        copiedImages: false,
        blendedLayers: false,
        offscreenRendered: false,
        cacheHits: false,
        misalignedImages: false,
      },
      applied: {
        flashUpdatedRegions: false,
        copiedImages: false,
        blendedLayers: true,
        offscreenRendered: true,
        cacheHits: false,
        misalignedImages: false,
      },
    });
  });

  test("passes the UDID and each write as option id / 0|1 pairs to osascript", async () => {
    const host = new RecordingHost({ stdout: SET_STDOUT });

    const change = await new OsascriptSimulatorRenderOverlayControl(host, DEVELOPER_DIR).set(UDID, {
      offscreenRendered: true,
      blendedLayers: true,
    });

    expect(change.applied.blendedLayers).toBe(true);
    expect(host.calls).toHaveLength(1);
    const [call] = host.calls;
    expect(call?.file).toBe("/usr/bin/osascript");
    expect(call?.args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(call?.args[3]).toContain("setCADebugOption:enabled:");
    expect(call?.args.slice(4)).toEqual([
      UDID,
      "/Applications/Xcode.app/Contents/Developer",
      "2",
      "1",
      "17",
      "1",
    ]);
  });

  test("a read writes nothing and returns the state", async () => {
    const host = new RecordingHost({ stdout: SET_STDOUT });

    const state = await new OsascriptSimulatorRenderOverlayControl(host, DEVELOPER_DIR).read(UDID);

    expect(state.offscreenRendered).toBe(true);
    expect(host.calls[0]?.args.slice(4)).toEqual([
      UDID,
      "/Applications/Xcode.app/Contents/Developer",
    ]);
  });

  test("reports osascript's stderr, not the script, when CoreSimulator fails", async () => {
    const failure = Object.assign(new Error("Command failed: /usr/bin/osascript ..."), {
      stderr: MISSING_STDERR,
      code: 1,
    });
    const control = new OsascriptSimulatorRenderOverlayControl(
      new RecordingHost({ error: failure }),
      DEVELOPER_DIR,
    );

    const error = await control.read(UDID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain(
      "was not found in the default device set (-2700)",
    );
    expect(String((error as Error).message)).not.toContain("ObjC.import");
  });

  test("passes the resolved developer directory to the script", async () => {
    const host = new RecordingHost({ stdout: SET_STDOUT });
    const resolved = async () => "/Applications/Xcode-27.2.0.app/Contents/Developer";

    await new OsascriptSimulatorRenderOverlayControl(host, resolved).read(UDID);

    expect(host.calls[0]?.args[5]).toBe("/Applications/Xcode-27.2.0.app/Contents/Developer");
  });

  test("a write to a shut-down Simulator is a typed actionable error", async () => {
    const failure = Object.assign(new Error("Command failed: /usr/bin/osascript ..."), {
      stderr: "execution error: Error: automobile-simulator-not-booted (-2700)",
      code: 1,
    });
    const control = new OsascriptSimulatorRenderOverlayControl(
      new RecordingHost({ error: failure }),
      DEVELOPER_DIR,
    );

    const error = await control
      .set(UDID, { blendedLayers: true })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActionableError);
    expect(String((error as Error).message)).toContain("is not booted");
  });

  test("the script checks the booted state only when it writes", async () => {
    const host = new RecordingHost({ stdout: SET_STDOUT });
    await new OsascriptSimulatorRenderOverlayControl(host, DEVELOPER_DIR).read(UDID);
    const script = host.calls[0]?.args[3] ?? "";
    expect(script).toContain("argv.length > 2 && Number(device.state) !== 3");
  });

  test("output missing an option is refused", () => {
    expect(() =>
      parseRenderOverlayOutput(JSON.stringify({ previous: { "2": true }, applied: { "2": true } })),
    ).toThrow("no state for render overlay");
    expect(() => parseRenderOverlayOutput("not json")).toThrow("unreadable render overlay state");
  });
});
