import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecResult } from "../../../src/models/ExecResult";
import {
  SimulatorResidueReader,
  type SimulatorResidueFileSystem,
} from "../../../src/utils/ios-cmdline-tools/SimulatorResidueReader";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/ios-simctl", name), "utf8");

const ROOT = "/Users/runner/Library/Developer/CoreSimulator/Devices";
const UDID = "8935BFAD-F01F-40FF-95E0-83FD0FF63DEB";
const DATA = `${ROOT}/${UDID}/data`;
const SAFARI_DATA = fixture("residue-safari-container.txt").trim();
const lines = (text: string) => text.split("\n").filter(Boolean);

function exec(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: () => false,
  };
}

function harness() {
  const state = {
    commands: [] as string[][],
    trees: new Map<string, string[] | null>([
      [`${DATA}/Media/DCIM`, lines(fixture("residue-dcim-files.txt"))],
      [`${DATA}/Documents`, lines(fixture("residue-documents-entries.txt"))],
      [`${SAFARI_DATA}/Documents`, []],
    ]),
    removed: [] as string[],
    safari: SAFARI_DATA as string | Error,
    preferences: fixture("residue-preferences-clean.xml"),
  };
  const files: SimulatorResidueFileSystem = {
    listFiles: async (directory) => state.trees.get(directory) ?? null,
    listEntries: async (directory) => state.trees.get(directory) ?? null,
    remove: async (path) => {
      state.removed.push(path);
    },
  };
  const reader = new SimulatorResidueReader({
    deviceSetRoot: ROOT,
    files,
    simctl: {
      executeCommandArgs: async (args) => {
        state.commands.push(args);
        if (args[0] === "get_app_container") {
          if (state.safari instanceof Error) {
            throw state.safari;
          }
          return exec(`${state.safari}\n`);
        }
        return exec(state.preferences);
      },
    },
  });
  return { state, reader, signal: new AbortController().signal };
}

describe("SimulatorResidueReader", () => {
  test("reads photos, system-filtered Documents, Safari Documents and keyboard defaults", async () => {
    const { reader, state, signal } = harness();
    const snapshot = await reader.read(UDID, signal);
    expect(snapshot.photos).toEqual(lines(fixture("residue-dcim-files.txt")));
    // Apple-owned databases and directories change on their own and are not residue.
    expect(snapshot.documents).toEqual(["snapshot-gallery.jpeg"]);
    expect(snapshot.safariDocuments).toEqual([]);
    expect(snapshot.keyboard).toEqual({});
    expect(state.commands).toEqual([
      ["get_app_container", UDID, "com.apple.mobilesafari", "data"],
      ["spawn", UDID, "defaults", "export", "com.apple.Preferences", "-"],
    ]);
  });

  test("a planted autocorrect default and out-of-band files are reported", async () => {
    const { reader, state, signal } = harness();
    state.preferences = fixture("residue-preferences-keyboard-planted.xml");
    state.trees.set(`${DATA}/Documents`, [
      ...lines(fixture("residue-documents-entries.txt")),
      "dirty-oob-1.txt",
    ]);
    state.trees.set(`${SAFARI_DATA}/Documents`, ["dirty-safari-1.txt"]);
    state.trees.set(`${DATA}/Media/DCIM`, [
      ...lines(fixture("residue-dcim-files.txt")),
      "100APPLE/IMG_0007.PNG",
    ]);
    const snapshot = await reader.read(UDID, signal);
    expect(snapshot.keyboard).toEqual({ KeyboardAutocorrection: false, KeyboardPrediction: true });
    expect(snapshot.documents).toEqual(["dirty-oob-1.txt", "snapshot-gallery.jpeg"]);
    expect(snapshot.safariDocuments).toEqual(["dirty-safari-1.txt"]);
    expect(snapshot.photos).toContain("100APPLE/IMG_0007.PNG");
  });

  test("an uninstalled Safari container has no residue, any other lookup failure is unreadable", async () => {
    const missing = harness();
    missing.state.safari = new Error(fixture("residue-get-app-container-missing.txt"));
    expect((await missing.reader.read(UDID, missing.signal)).safariDocuments).toEqual([]);
    const broken = harness();
    broken.state.safari = new Error("Unable to lookup in current state: Shutdown");
    await expect(broken.reader.read(UDID, broken.signal)).rejects.toThrow("Shutdown");
  });

  test("a missing DCIM or Documents directory reads as empty", async () => {
    const { reader, state, signal } = harness();
    state.trees.set(`${DATA}/Media/DCIM`, null);
    state.trees.set(`${DATA}/Documents`, null);
    const snapshot = await reader.read(UDID, signal);
    expect(snapshot.photos).toEqual([]);
    expect(snapshot.documents).toEqual([]);
  });

  test("removes only named top-level entries below the proven Documents roots", async () => {
    const { reader, state, signal } = harness();
    await reader.removeEntries(UDID, "documents", ["dirty-oob-1.txt"], signal);
    await reader.removeEntries(UDID, "safari-documents", ["dirty-safari-1.txt"], signal);
    expect(state.removed).toEqual([
      `${DATA}/Documents/dirty-oob-1.txt`,
      `${SAFARI_DATA}/Documents/dirty-safari-1.txt`,
    ]);
  });

  test.each(["", ".", "..", "../x", "a/b"])("refuses to remove the entry name %p", async (name) => {
    const { reader, state, signal } = harness();
    await expect(reader.removeEntries(UDID, "documents", [name], signal)).rejects.toThrow(
      "unproven",
    );
    expect(state.removed).toEqual([]);
  });

  test("refuses a Safari container outside the device's application data containers", async () => {
    const { reader, state, signal } = harness();
    state.safari = "/Users/runner/Documents";
    await expect(
      reader.removeEntries(UDID, "safari-documents", ["dirty.txt"], signal),
    ).rejects.toThrow("unproven");
    expect(state.removed).toEqual([]);
  });

  test("refuses a device id that is not a simulator UDID", async () => {
    const { reader, signal } = harness();
    await expect(reader.read("../escape", signal)).rejects.toThrow("simulator UDID");
  });
});
