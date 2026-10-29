import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { volumeSetScript } from "../../../src/features/media/AndroidVolume";
import {
  AndroidMediaSessionController,
  parseVolume,
} from "../../../src/features/media/MediaSessionController";
import {
  parseVolumeReadOutput,
  volumeMutationStreams,
  volumeRevertScript,
  VOLUME_KEY_PRESS_MUTATION_KEY,
  VOLUME_RESTORED_MARKER,
} from "../../../src/daemon/sessionBroker/mutations/volumeMutation";
import type { AdbCommandRunner } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { shellQuote } from "../../../src/utils/shellQuote";
import { FakeTimer } from "../../fakes/FakeTimer";

const fixture = (name: string) =>
  readFileSync(new URL(`../../fixtures/android-volume/${name}`, import.meta.url), "utf8");
const MUSIC = fixture("api37-stream-3.stdout.txt");
const TTS = fixture("api37-stream-9.stdout.txt");
const ACCESSIBILITY = fixture("api37-stream-10.stdout.txt");
const SET_OUTPUT = fixture("api37-audio-set-volume-3-5.issue.txt");

/** Runs only a local shell with a cmd function fake: no adb binary, device, or network. */
class VolumeShellFake implements AdbCommandRunner {
  readonly commands: string[] = [];
  readonly shellCommands: string[] = [];
  primaryOutput = SET_OUTPUT;
  primaryStatus = 0;
  // No captured source exists for these legacy success and unsupported responses.
  legacyOutput = "";
  legacyStatus = 0;
  readOutput = MUSIC;

  async executeCommand(command: string): Promise<ExecResult> {
    this.commands.push(command);
    const script = command.startsWith("shell sh -c ")
      ? `eval ${command.slice("shell sh -c ".length)}`
      : command.slice("shell ".length);
    const child = spawnSync(
      "/bin/sh",
      [
        "-c",
        `
      exec 3>&2
      cmd() {
        printf '%s\\n' "$*" >&3
        case "$*" in
          'audio set-volume '*) printf '%s' ${shellQuote(this.primaryOutput)}; return ${this.primaryStatus} ;;
          'media_session volume --stream '*' --set '*) printf '%s' ${shellQuote(this.legacyOutput)}; return ${this.legacyStatus} ;;
          'media_session volume --stream '*' --get') printf '%s' ${shellQuote(this.readOutput)} ;;
          *) return 127 ;;
        esac
      }
      # Literal-match grep fake keeps ten-stream verification within the unit timing budget.
      grep() {
        while IFS= read -r line; do
          case "$line" in *"$2"*) return 0 ;; esac
        done
        return 1
      }
      ${script}
    `,
      ],
      { encoding: "utf8" },
    );
    this.shellCommands.push(...(child.stderr ?? "").trim().split("\n"));
    // fd 3 writes command traces to the host stderr, separate from fake command output.
    const result = createExecResult(child.stdout ?? "", "");
    if (child.error || child.status !== 0) {
      throw Object.assign(child.error ?? new Error(`shell exited ${child.status}`), result);
    }
    return result;
  }
}

const setCommand = (stream: number, level: number) =>
  `shell sh -c ${shellQuote(volumeSetScript(stream, level))}`;

// Shell-executing tests require /bin/sh, which is unavailable on Windows.
describe.skipIf(process.platform === "win32")("Android volume setter", () => {
  test("API 37 uses the audio setter and preserves its captured output", async () => {
    const adb = new VolumeShellFake();
    expect((await adb.executeCommand(setCommand(3, 5))).stdout).toBe(SET_OUTPUT);
    expect(adb.shellCommands).toEqual(["audio set-volume 3 5"]);
  });

  // Synthetic control signals: no older-API command capture is available.
  test.each([
    ["Unknown command: set-volume", 0],
    ["Unknown command: set-volume", 1],
    ["Usage: cmd audio", 1],
    ["usage: cmd audio", 0],
    ["No shell command implementation.", 1],
    ["cmd: Can't find service: audio", 1],
    ["Unknown option: set-volume", 1],
  ])("falls back only on unsupported/usage output: %s (exit %i)", async (output, status) => {
    const adb = new VolumeShellFake();
    adb.primaryOutput = output;
    adb.primaryStatus = status;
    await adb.executeCommand(setCommand(3, 5));
    expect(adb.shellCommands).toEqual([
      "audio set-volume 3 5",
      "media_session volume --stream 3 --set 5",
    ]);
  });

  test.each(["Permission Denial: setStreamVolume", "adb: device offline", ""])(
    "does not fall back on an arbitrary failure: %s",
    async (output) => {
      const adb = new VolumeShellFake();
      adb.primaryOutput = output;
      adb.primaryStatus = 1;
      await expect(adb.executeCommand(setCommand(3, 5))).rejects.toThrow("shell exited 1");
      expect(adb.shellCommands).toEqual(["audio set-volume 3 5"]);
    },
  );

  test("propagates a failed legacy setter", async () => {
    const adb = new VolumeShellFake();
    adb.primaryOutput = "Unknown command: set-volume";
    adb.legacyStatus = 1;
    await expect(adb.executeCommand(setCommand(3, 5))).rejects.toThrow("shell exited 1");
  });
});

describe("volume journal verification", () => {
  test("parses captured TTS and accessibility readings without dropping either", () => {
    expect(
      parseVolumeReadOutput(`tts\n${TTS}accessibility\n${ACCESSIBILITY}`, ["tts", "accessibility"]),
    ).toEqual({ tts: 11, accessibility: 11 });
    expect(parseVolumeReadOutput(`tts\n${TTS}`, ["tts", "accessibility"])).toBeNull();
  });

  test.skipIf(process.platform === "win32")(
    "sets every journaled stream including 9 and 10 before fail-closed read-back",
    async () => {
      const streams = volumeMutationStreams(VOLUME_KEY_PRESS_MUTATION_KEY)!;
      const script = volumeRevertScript(VOLUME_KEY_PRESS_MUTATION_KEY, {
        state: "present",
        value: Object.fromEntries(streams.map((stream) => [stream, 11])),
      })!;
      const adb = new VolumeShellFake();
      // All fake reads return the captured level 11; command identities are checked separately.
      const result = await adb.executeCommand(`shell sh -c ${shellQuote(script)}`);
      expect(result.stdout.trim()).toBe(VOLUME_RESTORED_MARKER);
      const codes = [6, 5, 1, 11, 9, 10, 0, 2, 4, 3];
      expect(adb.shellCommands).toEqual([
        ...codes.map((code) => `audio set-volume ${code} 11`),
        ...codes.map((code) => `media_session volume --stream ${code} --get`),
      ]);
    },
  );

  test.skipIf(process.platform === "win32").each(["music", "tts", "accessibility"])(
    "a mismatched %s read-back never prints the marker",
    async (stream) => {
      const streams = volumeMutationStreams(VOLUME_KEY_PRESS_MUTATION_KEY)!;
      const script = volumeRevertScript(VOLUME_KEY_PRESS_MUTATION_KEY, {
        state: "present",
        value: Object.fromEntries(streams.map((name) => [name, name === stream ? 5 : 11])),
      })!;
      const adb = new VolumeShellFake();
      let stdout = "";
      try {
        await adb.executeCommand(`shell sh -c ${shellQuote(script)}`);
        throw new Error("unexpected restoration success");
      } catch (error) {
        expect(error).toMatchObject({ message: "shell exited 1" });
        stdout = (error as ExecResult).stdout;
      }
      expect(stdout).not.toContain(VOLUME_RESTORED_MARKER);
    },
  );
});

test.skipIf(process.platform === "win32")(
  "mediaSession uses the shared setter and keeps the prior-level restore receipt on API 37",
  async () => {
    const adb = new VolumeShellFake();
    const controller = new AndroidMediaSessionController(adb, new FakeTimer());
    const result = await controller.setVolume({ stream: "music", level: 5 });
    expect(adb.shellCommands).toEqual([
      "media_session volume --stream 3 --get",
      "audio set-volume 3 5",
      "media_session volume --stream 3 --get",
    ]);
    expect(result).toMatchObject({
      previousLevel: parseVolume(MUSIC)!.level,
      level: 11,
      verified: false, // The fake deliberately retains the captured pre-write read-back.
      restore: { volume: { stream: "music", level: 11 } },
    });
  },
);
