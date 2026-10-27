import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { macOsOnlyDescribe } from "../../helpers/macOsHost";
import type { ExecResult } from "../../../src/models/ExecResult";
import {
  SimulatorResidueReader,
  createNodeSimulatorResidueFileSystem,
  type SimulatorResidueFileSystem,
} from "../../../src/utils/ios-cmdline-tools/SimulatorResidueReader";

import { parseSimulatorContainerPath } from "../../../src/utils/ios-cmdline-tools/simulatorContainerPath";

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

function harness(deviceSetRoot = ROOT) {
  const state = {
    commands: [] as string[][],
    trees: new Map<string, string[] | null>([
      [`${DATA}/Media/DCIM`, lines(fixture("residue-dcim-files.txt"))],
      [`${DATA}/Documents`, lines(fixture("residue-documents-entries.txt"))],
      [`${SAFARI_DATA}/Documents`, []],
    ]),
    listed: [] as string[],
    identified: [] as string[],
    directories: new Set([SAFARI_DATA]),
    identifiers: new Map<string, string | null>([[SAFARI_DATA, "com.apple.mobilesafari"]]),
    removed: [] as string[],
    safari: SAFARI_DATA as string | Error,
    preferences: fixture("residue-preferences-clean.plist"),
    accessibility: fixture("residue-accessibility-clean.plist"),
  };
  const files: SimulatorResidueFileSystem = {
    listFiles: async (directory) => {
      state.listed.push(directory);
      return state.trees.get(directory) ?? null;
    },
    listEntries: async (directory) => {
      state.listed.push(directory);
      return state.trees.get(directory) ?? null;
    },
    containerIdentifier: async (directory) => {
      state.identified.push(directory);
      return state.directories.has(directory) ? (state.identifiers.get(directory) ?? null) : null;
    },
    remove: async (path) => {
      state.removed.push(path);
    },
  };
  const reader = new SimulatorResidueReader({
    deviceSetRoot,
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
        return exec(
          args[4] === "com.apple.Accessibility" ? state.accessibility : state.preferences,
        );
      },
    },
  });
  return { state, reader, signal: new AbortController().signal };
}

macOsOnlyDescribe("SimulatorResidueReader", () => {
  test("reads photos, system-filtered Documents, Safari Documents and keyboard defaults", async () => {
    const { reader, state, signal } = harness();
    const snapshot = await reader.read(UDID, signal);
    expect(snapshot.photos).toEqual(lines(fixture("residue-dcim-files.txt")));
    // Apple-owned databases and directories change on their own and are not residue.
    expect(snapshot.documents).toEqual(["snapshot-gallery.jpeg"]);
    expect(snapshot.safariDocuments).toEqual([]);
    expect(snapshot.keyboard).toEqual({});
    expect(snapshot.accessibility).toEqual({});
    expect(state.commands).toEqual([
      ["get_app_container", UDID, "com.apple.mobilesafari", "data"],
      ["spawn", UDID, "defaults", "export", "com.apple.Preferences", "-"],
      ["spawn", UDID, "defaults", "export", "com.apple.Accessibility", "-"],
    ]);
  });

  // Captured from a fresh iOS 27.0 simulator after `simctl ui increase_contrast enabled`, then
  // `disabled` (#15017): turning the setting back off leaves its defaults behind as 0.
  test("reads the increase-contrast defaults simctl leaves behind, enabled or disabled", async () => {
    const enabled = harness();
    enabled.state.accessibility = fixture("residue-accessibility-increase-contrast-enabled.plist");
    expect((await enabled.reader.read(UDID, enabled.signal)).accessibility).toEqual({
      DarkenSystemColors: 1,
      PointerIncreasedContrastEnabled: 1,
    });
    const disabled = harness();
    disabled.state.accessibility = fixture(
      "residue-accessibility-increase-contrast-disabled.plist",
    );
    expect((await disabled.reader.read(UDID, disabled.signal)).accessibility).toEqual({
      DarkenSystemColors: 0,
      PointerIncreasedContrastEnabled: 0,
    });
  });

  test("a planted autocorrect default and out-of-band files are reported", async () => {
    const { reader, state, signal } = harness();
    state.preferences = fixture("residue-preferences-keyboard-planted.plist");
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

const CLONE = "B2AD9D00-8167-4C18-861C-8D1B2E297BA6";
const CLONE_ROOT = "/Users/jason/Library/Developer/CoreSimulator/Devices";
const TEMPLATE_DATA = fixture("residue-safari-clone-container.txt").trim();
const CONTAINER_UUID = "877F3F94-D9DE-4772-A0BA-38F2F5794968";
const CLONE_DATA = `${CLONE_ROOT}/${CLONE}/data/Containers/Data/Application/${CONTAINER_UUID}`;

function cloneHarness() {
  const rig = harness(CLONE_ROOT);
  rig.state.safari = TEMPLATE_DATA;
  rig.state.directories.add(CLONE_DATA);
  rig.state.identifiers.set(CLONE_DATA, "com.apple.mobilesafari");
  rig.state.trees.set(`${CLONE_DATA}/Documents`, ["download.txt"]);
  return rig;
}

macOsOnlyDescribe("clone Safari ownership", () => {
  test("reads only the clone Safari Documents when simctl reports its template", async () => {
    const rig = cloneHarness();
    expect((await rig.reader.read(CLONE, rig.signal)).safariDocuments).toEqual(["download.txt"]);
    expect(rig.state.listed).toContain(`${CLONE_DATA}/Documents`);
    expect(rig.state.identified).toEqual([CLONE_DATA]);
    expect(rig.state.listed.some((path) => path.startsWith(TEMPLATE_DATA))).toBe(false);
  });

  test("rebuilds a same-UDID path with the requested device casing", async () => {
    const rig = cloneHarness();
    rig.state.safari = CLONE_DATA.replace(CLONE, CLONE.toLowerCase());
    await rig.reader.removeEntries(CLONE, "safari-documents", ["download.txt"], rig.signal);
    expect(rig.state.removed).toEqual([`${CLONE_DATA}/Documents/download.txt`]);
    expect((await rig.reader.read(CLONE, rig.signal)).safariDocuments).toEqual(["download.txt"]);
    expect(rig.state.listed).toContain(`${CLONE_DATA}/Documents`);
    expect(rig.state.identified).toEqual([]);
  });

  test("removes only clone Safari entries, never template entries", async () => {
    const rig = cloneHarness();
    await rig.reader.removeEntries(CLONE, "safari-documents", ["download.txt"], rig.signal);
    expect(rig.state.removed).toEqual([`${CLONE_DATA}/Documents/download.txt`]);
    expect(rig.state.listed.some((path) => path.startsWith(TEMPLATE_DATA))).toBe(false);
  });

  test.each([
    ["identifier mismatch", TEMPLATE_DATA, "com.apple.SafariViewService"],
    ["identifier missing", TEMPLATE_DATA, null],
    ["own directory absent", TEMPLATE_DATA, undefined],
    [
      "outside device set",
      TEMPLATE_DATA.replace(CLONE_ROOT, "/elsewhere"),
      "com.apple.mobilesafari",
    ],
    [
      "parent segment",
      TEMPLATE_DATA.replace("/data/", "/other/../data/"),
      "com.apple.mobilesafari",
    ],
    ["dot segment", TEMPLATE_DATA.replace("/data/", "/./data/"), "com.apple.mobilesafari"],
    ["extra segment", `${TEMPLATE_DATA}/Documents`, "com.apple.mobilesafari"],
    [
      "non UDID",
      TEMPLATE_DATA.replace("4C4FD11F-2766-4332-9DFF-56073DFEB085", "template"),
      "com.apple.mobilesafari",
    ],
    ["trailing slash", `${TEMPLATE_DATA}/`, "com.apple.mobilesafari"],
  ] as const)("refuses unproven clone path: %s", async (_name, path, identifier) => {
    const rig = cloneHarness();
    rig.state.safari = path;
    rig.state.identifiers.set(CLONE_DATA, identifier ?? null);
    if (identifier === undefined) {
      rig.state.directories.delete(CLONE_DATA);
      rig.state.identifiers.set(CLONE_DATA, "com.apple.mobilesafari");
    }
    await expect(
      rig.reader.removeEntries(CLONE, "safari-documents", ["download.txt"], rig.signal),
    ).rejects.toThrow("unproven file path");
    expect(rig.state.listed).toEqual([]);
    expect(rig.state.removed).toEqual([]);
    await expect(rig.reader.read(CLONE, rig.signal)).rejects.toThrow("unproven file path");
    expect(rig.state.listed).toEqual([]);
    expect(rig.state.identified.every((entry) => entry === CLONE_DATA)).toBe(true);
  });

  test("strict container parser accepts exact UUID shapes including lowercase", () => {
    expect(parseSimulatorContainerPath(TEMPLATE_DATA, CLONE_ROOT)).toEqual({
      udid: "4C4FD11F-2766-4332-9DFF-56073DFEB085",
      containerUuid: CONTAINER_UUID,
    });
    expect(
      parseSimulatorContainerPath(
        TEMPLATE_DATA.replace(
          "4C4FD11F-2766-4332-9DFF-56073DFEB085",
          "4c4fd11f-2766-4332-9dff-56073dfeb085",
        ).replace(CONTAINER_UUID, CONTAINER_UUID.toLowerCase()),
        CLONE_ROOT,
      )?.containerUuid,
    ).toBe(CONTAINER_UUID.toLowerCase());
  });
  test.each([
    `${TEMPLATE_DATA}/`,
    `${TEMPLATE_DATA}/Documents`,
    TEMPLATE_DATA.replace(CONTAINER_UUID, "invalid"),
    TEMPLATE_DATA.replace("/data/", "/../data/"),
    TEMPLATE_DATA.replace("/data/", "//data/"),
    TEMPLATE_DATA.replace(CLONE_ROOT, "/outside"),
  ])("strict container parser rejects %s", (path) => {
    expect(parseSimulatorContainerPath(path, CLONE_ROOT)).toBeNull();
  });

  test("node containerIdentifier reads the metadata identifier through PlistReader", async () => {
    const paths: string[] = [];
    const files = createNodeSimulatorResidueFileSystem({
      readJsonFile: async (path) => {
        paths.push(path);
        return { MCMMetadataIdentifier: "com.apple.mobilesafari" };
      },
    });
    expect(await files.containerIdentifier(CLONE_DATA)).toBe("com.apple.mobilesafari");
    expect(paths).toEqual([`${CLONE_DATA}/.com.apple.mobile_container_manager.metadata.plist`]);
  });
  test("node containerIdentifier returns null for ENOENT", async () => {
    const files = createNodeSimulatorResidueFileSystem({
      readJsonFile: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });
    expect(await files.containerIdentifier(CLONE_DATA)).toBeNull();
  });
  test.each([null, [], {}, { MCMMetadataIdentifier: 123 }])(
    "node containerIdentifier refuses malformed metadata %p",
    async (value) => {
      const files = createNodeSimulatorResidueFileSystem({ readJsonFile: async () => value });
      expect(await files.containerIdentifier(CLONE_DATA)).toBeNull();
    },
  );
  test("node containerIdentifier fails closed on plist errors", async () => {
    const files = createNodeSimulatorResidueFileSystem({
      readJsonFile: async () => {
        throw new Error("invalid plist");
      },
    });
    expect(await files.containerIdentifier(CLONE_DATA)).toBeNull();
  });
});
