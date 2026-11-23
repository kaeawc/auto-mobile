import { describe, expect, test } from "bun:test";
import {
  OsascriptSimulatorKeyboardBridge,
  SIMULATOR_KEYBOARD_JXA,
  resolveDeveloperDirectory,
} from "../../../src/utils/ios/SimulatorKeyboardBridge";
import type { ExecFileAsync } from "../../../src/utils/HostCommandExecutor";

const UDID = "85E99D67-7088-4999-89CB-3C06DBE410BF";
const DEVELOPER_DIR = "/Applications/Xcode-27.2.0.app/Contents/Developer";

function rig(stdout: string | Error) {
  const calls: { file: string; args: string[] }[] = [];
  const exec: ExecFileAsync = async (file, args) => {
    calls.push({ file, args });
    if (stdout instanceof Error) {
      throw stdout;
    }
    return { stdout, stderr: "" };
  };
  const bridge = new OsascriptSimulatorKeyboardBridge(exec, async () => DEVELOPER_DIR);
  return { bridge, calls };
}

describe("OsascriptSimulatorKeyboardBridge", () => {
  test("connects the hardware keyboard with the layout's Apple keyboard type code", async () => {
    const { bridge, calls } = rig('{"ok":true}\n');
    await bridge.setHardwareKeyboard(UDID, true, "iso");
    expect(calls).toEqual([
      {
        file: "osascript",
        args: [
          "-l",
          "JavaScript",
          "-e",
          SIMULATOR_KEYBOARD_JXA,
          DEVELOPER_DIR,
          UDID,
          "hardware",
          "1",
          "205",
        ],
      },
    ]);
  });

  test("disconnecting passes 0 and the ANSI code", async () => {
    const { bridge, calls } = rig('{"ok":true}');
    await bridge.setHardwareKeyboard(UDID, false, "ansi");
    expect(calls[0]!.args.slice(-3)).toEqual(["hardware", "0", "204"]);
  });

  test("a keyboard language is passed through as the input mode identifier", async () => {
    const { bridge, calls } = rig('{"ok":true}');
    await bridge.setKeyboardLanguage(UDID, "ja_JP-Kana");
    expect(calls[0]!.args.slice(-2)).toEqual(["language", "ja_JP-Kana"]);
  });

  test("CoreSimulator answering NO for a language is an actionable error", async () => {
    const { bridge } = rig('{"ok":false}');
    await expect(bridge.setKeyboardLanguage(UDID, "zz")).rejects.toThrow(
      'CoreSimulator has no keyboard for language "zz"',
    );
  });

  test("a malformed language never reaches osascript", async () => {
    const { bridge, calls } = rig('{"ok":true}');
    await expect(bridge.setKeyboardLanguage(UDID, "en US")).rejects.toThrow(
      "is not a keyboard identifier",
    );
    expect(calls).toHaveLength(0);
  });

  test("a refused hardware keyboard change is an error", async () => {
    const { bridge } = rig('{"ok":false}');
    await expect(bridge.setHardwareKeyboard(UDID, false, "ansi")).rejects.toThrow(
      "refused to disconnect the hardware keyboard",
    );
  });

  test.each([
    ["device-not-found", "is not in the default CoreSimulator device set"],
    ["device-not-booted", "is not booted"],
    ["private-api-unavailable", "keyboard API is unavailable"],
  ])("the script's %s code becomes a readable error", async (code, message) => {
    const { bridge } = rig(JSON.stringify({ error: code }));
    await expect(bridge.setHardwareKeyboard(UDID, true, "ansi")).rejects.toThrow(message);
  });

  test("unexpected output is reported rather than treated as success", async () => {
    const { bridge } = rig("garbage");
    await expect(bridge.setHardwareKeyboard(UDID, true, "ansi")).rejects.toThrow(
      "printed unexpected output: garbage",
    );
  });

  test("an osascript failure is wrapped with the device", async () => {
    const { bridge } = rig(new Error("osascript: execution error"));
    await expect(bridge.setKeyboardLanguage(UDID, "fr_FR")).rejects.toThrow(
      `Simulator keyboard call failed on ${UDID}`,
    );
  });
});

describe("resolveDeveloperDirectory", () => {
  test("DEVELOPER_DIR naming an Xcode app resolves to its Contents/Developer", async () => {
    const resolved = await resolveDeveloperDirectory(
      { DEVELOPER_DIR: "/Applications/Xcode-27.2.0.app" },
      async (target) => target,
    );
    expect(resolved).toBe(DEVELOPER_DIR);
  });

  test("without DEVELOPER_DIR the xcode-select link is followed", async () => {
    const seen: string[] = [];
    const resolved = await resolveDeveloperDirectory({}, async (target) => {
      seen.push(target);
      return DEVELOPER_DIR;
    });
    expect(seen).toEqual(["/var/db/xcode_select_link"]);
    expect(resolved).toBe(DEVELOPER_DIR);
  });
});
