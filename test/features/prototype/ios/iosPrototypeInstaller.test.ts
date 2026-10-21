import { describe, expect, spyOn, test } from "bun:test";
import { IosPrototypeInstaller } from "../../../../src/features/prototype/ios/iosPrototypeInstaller";
import { prototypeBundleId } from "../../../../src/features/prototype/ios/iosPrototypeBundleId";
import { DefaultDataContainerWriter } from "../../../../src/features/prototype/ios/iosPrototypeInstallerAdapters";
import * as errors from "../../../../src/features/prototype/ios/iosPrototypeInstallerErrors";
import fixture from "../../../fixtures/prototype-saved-layout/layout.json";
import type { PrototypeJson } from "../../../../src/features/prototype/prototypeSpec";
import type { PrototypeAssetUpload } from "../../../../src/features/prototype/prototypeAssets";
import { DirectorySavedPrototypeLayoutWriter } from "../../../../src/features/prototype/savedPrototypeLayout";
import { FakeSavedPrototypeLayoutFileSystem } from "../../../fakes/FakeSavedPrototypeLayoutFileSystem";
import { FakeSavedPrototypeLayoutWriter } from "../../../fakes/FakeSavedPrototypeLayoutWriter";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { logger } from "../../../../src/utils/logger";
import { FakeHostCommandExecutor } from "../../../fakes/FakeHostCommandExecutor";
import {
  InstallerOperationRecorder,
  FakeTemplateProvider,
  FakeInstallerFileSystem,
  FakePrototypePlist,
  FakePrototypeIconRenderer,
  FakePrototypeSimctl,
  FakePrototypeDataWriter,
} from "../../../fakes/FakePrototypeInstaller";

const udid = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const app = "/temp/install/PrototypeViewer.app";
const input = {
  udid,
  prototypeId: "My Prototype",
  spec: { version: 1 },
  icon: { backgroundColor: "#123456" },
};

function harness() {
  const operations = new InstallerOperationRecorder();
  const template = new FakeTemplateProvider(operations);
  const files = new FakeInstallerFileSystem(operations);
  const plist = new FakePrototypePlist(operations);
  const icons = new FakePrototypeIconRenderer(operations);
  const simctl = new FakePrototypeSimctl(operations);
  const data = new FakePrototypeDataWriter(operations);
  const commands = new FakeHostCommandExecutor();
  const execute = commands.executeCommand.bind(commands);
  spyOn(commands, "executeCommand").mockImplementation(async (file, args) => {
    operations.record(args?.includes("--verify") ? "verify" : "sign");
    return execute(file, args);
  });
  const installer = new IosPrototypeInstaller({
    template,
    files,
    plist,
    icons,
    simctl,
    data,
    commands,
  });
  return { installer, operations, files, plist, icons, simctl, data, commands };
}

describe("IosPrototypeInstaller", () => {
  test("stamps copied plist and icons in pipeline order without changing executable/layout", async () => {
    const h = harness();
    const result = await h.installer.install({ ...input, label: "Viewer Label" });
    expect(result).toEqual({
      bundleId: prototypeBundleId(input.prototypeId),
      displayName: "Viewer Label",
    });
    expect(h.operations.events).toEqual([
      "resolve",
      "mkdtemp",
      "copy",
      "plist-read",
      "plist-write",
      "icon:120",
      `write:${app}/PrototypeViewerIcon60x60@2x.png`,
      "icon:180",
      `write:${app}/PrototypeViewerIcon60x60@3x.png`,
      "sign",
      "verify",
      "install",
      "container",
      "data",
      "cleanup",
    ]);
    expect(h.files.copies).toEqual([["/template/Viewer.app", app]]);
    expect(h.plist.written).toEqual({
      path: `${app}/Info.plist`,
      value: {
        CFBundleExecutable: "PrototypeViewer",
        CFBundleIcons: { untouched: true },
        CFBundleIdentifier: result.bundleId,
        CFBundleDisplayName: "Viewer Label",
        CFBundleName: "Viewer Label",
      },
    });
    expect(h.icons.inputs).toEqual([
      { input: input.icon, sizePx: 120 },
      { input: input.icon, sizePx: 180 },
    ]);
    expect(h.files.files.get(`${app}/PrototypeViewerIcon60x60@2x.png`)).toEqual(
      Buffer.from("png:120"),
    );
    expect(h.files.files.get(`${app}/PrototypeViewerIcon60x60@3x.png`)).toEqual(
      Buffer.from("png:180"),
    );
    expect(h.commands.getExecutedCommands()).toEqual([
      `codesign --force --sign - --timestamp=none ${app}`,
      `codesign --verify ${app}`,
    ]);
    expect(h.simctl.installed).toEqual([{ udid, appPath: app }]);
    expect(h.data.writes).toEqual([
      { containerPath: "/container", spec: input.spec, assets: undefined },
    ]);
    expect(h.files.removed).toEqual(["/temp/install"]);
  });

  for (const physical of ["00008110-00123456789ABCDE", "a".repeat(40), "not-a-udid"]) {
    test(`refuses non-simulator ${physical} before all IO and id validation`, async () => {
      const h = harness();
      await expect(
        h.installer.install({ ...input, udid: physical, prototypeId: "" }),
      ).rejects.toBeInstanceOf(errors.PrototypeInstallPhysicalDeviceError);
      expect(h.operations.events).toEqual([]);
      expect(h.commands.getExecutedCommands()).toEqual([]);
    });
  }

  test("invalid id refuses before template resolution", async () => {
    const h = harness();
    await expect(h.installer.install({ ...input, prototypeId: " \t " })).rejects.toBeInstanceOf(
      errors.InvalidPrototypeIdError,
    );
    expect(h.operations.events).toEqual([]);
  });

  const failures = [
    ["resolve", errors.TemplateResolveError],
    ["mkdtemp", errors.TemplateCopyError],
    ["copy", errors.TemplateCopyError],
    ["plist-read", errors.PlistRewriteError],
    ["plist-write", errors.PlistRewriteError],
    ["icon:120", errors.IconRenderError],
    ["icon:180", errors.IconRenderError],
    [`write:${app}/PrototypeViewerIcon60x60@2x.png`, errors.IconRenderError],
    [`write:${app}/PrototypeViewerIcon60x60@3x.png`, errors.IconRenderError],
    ["sign", errors.CodesignError],
    ["verify", errors.CodesignError],
    ["install", errors.SimctlInstallError],
    ["container", errors.DataContainerError],
    ["data", errors.DataWriteError],
  ] as const;
  for (const [event, ErrorClass] of failures) {
    test(`maps ${event} failure and cleans allocated temp directory`, async () => {
      const h = harness();
      h.operations.failAt = event;
      const error = await h.installer.install(input).then(
        () => undefined,
        (reason) => reason,
      );
      expect(error).toBeInstanceOf(ErrorClass);
      expect(error.cause).toBe(h.operations.error);
      expect(typeof error.code).toBe("string");
      if (error instanceof errors.CodesignError) {
        expect<unknown>(error.step).toBe(event);
      }
      expect(h.files.removed).toEqual(
        ["resolve", "mkdtemp"].includes(event) ? [] : ["/temp/install"],
      );
      if (!["resolve", "mkdtemp"].includes(event)) {
        expect(h.operations.events.at(-1)).toBe("cleanup");
      }
    });
  }

  test("cleanup failure does not mask primary typed failure and cause", async () => {
    const h = harness();
    h.operations.failAt = "data";
    const cleanupError = new Error("cleanup denied");
    spyOn(h.files, "rm").mockRejectedValue(cleanupError);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const error = await h.installer.install(input).then(
        () => undefined,
        (reason) => reason,
      );
      expect(error).toBeInstanceOf(errors.DataWriteError);
      expect(error.cause).toBe(h.operations.error);
      expect(warn).toHaveBeenCalledWith("Could not remove temporary prototype viewer directory", {
        temp: "/temp/install",
        error: cleanupError,
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("returns successful install result when cleanup fails", async () => {
    const h = harness();
    h.operations.failAt = "cleanup";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await h.installer.install(input)).toEqual({
        bundleId: prototypeBundleId(input.prototypeId),
        displayName: input.prototypeId,
      });
      expect(h.simctl.installed).toEqual([{ udid, appPath: app }]);
      expect(h.data.writes).toEqual([
        { containerPath: "/container", spec: input.spec, assets: undefined },
      ]);
      expect(h.files.removed).toEqual(["/temp/install"]);
      expect(warn).toHaveBeenCalledWith("Could not remove temporary prototype viewer directory", {
        temp: "/temp/install",
        error: h.operations.error,
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("rejects malformed plist dictionaries and empty container responses", async () => {
    const h = harness();
    h.plist.value = [];
    await expect(h.installer.install(input)).rejects.toBeInstanceOf(errors.PlistRewriteError);
    h.plist.value = {};
    h.simctl.containerPath = " \n";
    await expect(h.installer.install(input)).rejects.toBeInstanceOf(errors.DataContainerError);
    expect(h.files.removed).toHaveLength(2);
  });

  test("update reinstalls same bundle and replaces spec without uninstalling", async () => {
    const h = harness();
    const files = new FakeSavedPrototypeLayoutFileSystem();
    const writer = new DefaultDataContainerWriter(
      new DirectorySavedPrototypeLayoutWriter(files, new FakeIdGenerator()),
      h.files,
    );
    spyOn(h.data, "write").mockImplementation((path, spec, assets) =>
      writer.write(path, spec, assets),
    );
    const spec = JSON.parse(fixture.specJson) as PrototypeJson;
    const first = await h.installer.install({ ...input, spec });
    if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
      throw new Error("Expected object spec");
    }
    const updatedSpec = { ...spec, id: "updated" };
    const second = await h.installer.install({ ...input, spec: updatedSpec });
    expect(first.bundleId).toBe(second.bundleId);
    expect(h.simctl.containers).toEqual([first.bundleId, first.bundleId]);
    expect(h.simctl.installed).toHaveLength(2);
    expect(h.simctl.deleted).toEqual([]);
    expect(h.plist.written?.value.CFBundleName).toBe(input.prototypeId);
    expect(h.plist.written?.value.CFBundleDisplayName).toBe(input.prototypeId);
    expect(
      Buffer.from(files.files.get("/container/Documents/prototype/spec.json") ?? []).toString(),
    ).toBe(JSON.stringify(updatedSpec));
    expect(files.files.has("/container/Documents/prototype.json")).toBe(false);
    expect(h.files.removed).toEqual([
      "/container/Documents/prototype.json",
      "/temp/install",
      "/container/Documents/prototype.json",
      "/temp/install",
    ]);
  });

  test("lists only prototype prefix apps and deletes by bundle id or explicit prototype id", async () => {
    const h = harness();
    const bundleId = prototypeBundleId("mine");
    h.simctl.apps = [{ bundleId, displayName: "Mine" }, { bundleId: "com.apple.Maps" }];
    expect(await h.installer.list(udid)).toEqual([{ bundleId, displayName: "Mine" }]);
    await expect(h.installer.delete(udid, "com.apple.Maps")).rejects.toBeInstanceOf(
      errors.NotPrototypeBundleError,
    );
    expect(h.simctl.deleted).toEqual([]);
    await h.installer.delete(udid, bundleId);
    await h.installer.delete(udid, { prototypeId: "mine" });
    expect(h.simctl.deleted).toEqual([bundleId, bundleId]);
  });

  test("list/delete refuse physical devices before IO", async () => {
    const h = harness();
    await expect(h.installer.list("physical")).rejects.toBeInstanceOf(
      errors.PrototypeInstallPhysicalDeviceError,
    );
    await expect(h.installer.delete("physical", prototypeBundleId("mine"))).rejects.toBeInstanceOf(
      errors.PrototypeInstallPhysicalDeviceError,
    );
    expect(h.operations.events).toEqual([]);
  });

  for (const [operation, ErrorClass, code, message] of [
    [
      "list",
      errors.PrototypeListError,
      "prototype_list",
      "Could not list installed prototype viewers",
    ],
    [
      "uninstall",
      errors.PrototypeUninstallError,
      "prototype_uninstall",
      "Could not uninstall the prototype viewer",
    ],
  ] as const) {
    test(`${operation} failure has an accurate typed error, code and cause`, async () => {
      const h = harness();
      h.operations.failAt = operation;
      const error = await (
        operation === "list"
          ? h.installer.list(udid)
          : h.installer.delete(udid, prototypeBundleId("mine"))
      ).then(
        () => undefined,
        (reason) => reason,
      );
      expect(error).toBeInstanceOf(ErrorClass);
      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
      expect(error.cause).toBe(h.operations.error);
    });
  }

  test("default data writer delegates versioned layout and removes legacy spec", async () => {
    const operations = new InstallerOperationRecorder();
    const files = new FakeInstallerFileSystem(operations);
    const layout = new FakeSavedPrototypeLayoutWriter();
    const spec = JSON.parse(fixture.specJson) as PrototypeJson;
    await new DefaultDataContainerWriter(layout, files).write("/data", spec);
    expect(layout.requests).toEqual([
      {
        destination: "/data/Documents/prototype",
        request: { specJson: JSON.stringify(spec), assets: [] },
      },
    ]);
    expect(operations.events).toEqual(["cleanup"]);
    expect(files.removed).toEqual(["/data/Documents/prototype.json"]);
    expect([...files.files]).toEqual([]);
  });

  test("passes caller image and font bytes unchanged to the data writer", async () => {
    const h = harness();
    const assets: readonly PrototypeAssetUpload[] = [
      { id: "image", mimeType: "image/png", bytes: Uint8Array.of(1) },
      { id: "font", mimeType: "font/ttf", bytes: Uint8Array.of(2) },
    ];
    await h.installer.install({ ...input, assets });
    expect(h.data.writes).toEqual([{ containerPath: "/container", spec: input.spec, assets }]);
    expect(h.data.writes[0].assets).toBe(assets);
  });

  test("wraps layout rejection with its reason in DataWriteError", async () => {
    const h = harness();
    const layout = new FakeSavedPrototypeLayoutWriter();
    layout.result = { kind: "rejected", reason: "INVALID_SPEC", message: "Invalid saved spec" };
    const writer = new DefaultDataContainerWriter(layout, h.files);
    spyOn(h.data, "write").mockImplementation((path, spec, assets) =>
      writer.write(path, spec, assets),
    );
    const error = await h.installer.install(input).then(
      () => undefined,
      (reason) => reason,
    );
    expect(error).toBeInstanceOf(errors.DataWriteError);
    expect(error.cause).toMatchObject({ message: "Invalid saved spec", reason: "INVALID_SPEC" });
    expect(h.files.removed).toEqual(["/temp/install"]);
  });
});
