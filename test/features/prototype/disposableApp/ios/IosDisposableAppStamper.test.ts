import { describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { IosDisposableAppStamper } from "../../../../../src/features/prototype/disposableApp/ios/IosDisposableAppStamper";
import { disposableAppId } from "../../../../../src/features/prototype/disposableApp/disposableAppId";
import { disposableAppDeclarations } from "../../../../../src/features/prototype/disposableApp/disposableAppPermissions";
import { selectDisposableAppTemplate } from "../../../../../src/features/prototype/disposableApp/disposableAppTemplates";
import { ActionableError } from "../../../../../src/models/ActionableError";
import { FakeHostCommandExecutor } from "../../../../fakes/FakeHostCommandExecutor";
import {
  FakeInstallerFileSystem,
  FakePrototypeIconRenderer,
  FakePrototypePlist,
  InstallerOperationRecorder,
} from "../../../../fakes/FakePrototypeInstaller";

const appId = disposableAppId("ios", "feedly");
const source = path.join("template", "Viewer.app");
const spec = {
  id: "feedly",
  requires: { permissions: [{ name: "camera", purpose: "Scan a barcode" }], background: ["audio"] },
};

function harness() {
  const operations = new InstallerOperationRecorder();
  const files = new FakeInstallerFileSystem(operations);
  const plist = new FakePrototypePlist(operations);
  const icons = new FakePrototypeIconRenderer(operations);
  const commands = new FakeHostCommandExecutor();
  const template = { resolve: mock(async () => source) };
  plist.value = {
    CFBundleIdentifier: "template.id",
    CFBundleDisplayName: "Template",
    CFBundleName: "Template",
    CFBundleExecutable: "PrototypeViewer",
    CFBundleShortVersionString: "1.2",
    NSCameraUsageDescription: "Template camera",
    NSFaceIDUsageDescription: "Template Face ID",
    NSLocationTemporaryUsageDescriptionDictionary: { Example: "Location" },
    UIBackgroundModes: ["voip"],
    UILaunchScreen: { UIColorName: "TemplateColor", UIImageName: "Logo" },
  };
  return {
    stamper: new IosDisposableAppStamper({ template, files, plist, icons, commands }),
    template,
    files,
    plist,
    icons,
    commands,
  };
}

describe("IosDisposableAppStamper", () => {
  test("selects one Viewer base flavor without resolving the bundle", async () => {
    const { stamper, template } = harness();
    const templates = await stamper.templates();
    expect(templates).toHaveLength(1);
    expect(selectDisposableAppTemplate(spec, templates).name).toBe("base");
    expect(templates[0]?.capabilities).toContain("prototype_glass_v1");
    expect(template.resolve).not.toHaveBeenCalled();
  });

  test("stamps identity, declared permissions, background modes, icon and spec before signing", async () => {
    const { stamper, files, plist, icons, commands } = harness();
    const template = selectDisposableAppTemplate(spec, await stamper.templates());
    const { artifactPath, version } = await stamper.stamp({
      appId,
      slug: "feedly",
      label: "Feedly",
      spec,
      template,
      declarations: disposableAppDeclarations(spec),
      icon: { backgroundColor: "#7F123456" },
    });

    expect(path.basename(artifactPath)).toBe("PrototypeViewer.app");
    expect(version).toBe("1.2");
    expect(files.copies).toEqual([[source, artifactPath]]);
    expect(plist.written).toEqual({
      path: path.join(artifactPath, "Info.plist"),
      value: {
        CFBundleIdentifier: appId,
        CFBundleDisplayName: "Feedly",
        CFBundleName: "Feedly",
        CFBundleExecutable: "PrototypeViewer",
        CFBundleShortVersionString: "1.2",
        NSCameraUsageDescription: "Scan a barcode",
        NSLocationTemporaryUsageDescriptionDictionary: { Example: "Location" },
        UIBackgroundModes: ["audio"],
        UILaunchScreen: { UIImageName: "Logo" },
      },
    });
    expect(icons.inputs).toEqual([
      { input: { backgroundColor: "#1234567F" }, sizePx: 120 },
      { input: { backgroundColor: "#1234567F" }, sizePx: 180 },
    ]);
    expect(files.files.get(path.join(artifactPath, "PrototypeViewerIcon60x60@2x.png"))).toEqual(
      Buffer.from("png:120"),
    );
    expect(files.files.get(path.join(artifactPath, "PrototypeViewerIcon60x60@3x.png"))).toEqual(
      Buffer.from("png:180"),
    );
    expect(files.files.get(path.join(artifactPath, "prototype.json"))).toBe(JSON.stringify(spec));
    expect(commands.getExecutedCalls().map(({ command, args }) => [command, ...args])).toEqual([
      ["codesign", "--force", "--sign", "-", "--timestamp=none", artifactPath],
      ["codesign", "--verify", artifactPath],
    ]);
  });

  test("omits empty declarations and keeps the original icon when no color is supplied", async () => {
    const { stamper, plist, icons } = harness();
    const spec = { id: "feedly" };
    await stamper.stamp({
      appId,
      slug: "feedly",
      label: "Feedly",
      spec,
      template: selectDisposableAppTemplate(spec, await stamper.templates()),
      declarations: disposableAppDeclarations(spec),
    });
    expect(plist.written?.value).not.toHaveProperty("UIBackgroundModes");
    expect(plist.written?.value).not.toHaveProperty("NSCameraUsageDescription");
    expect(plist.written?.value).not.toHaveProperty("NSFaceIDUsageDescription");
    expect(icons.inputs).toEqual([]);
  });

  test.each(["CFBundleIdentifier", "NSUnknownUsageDescription"])(
    "rejects the usage-description key %s before copying",
    async (key) => {
      const { stamper, template } = harness();
      const declarations = disposableAppDeclarations(spec);
      declarations.ios.usageDescriptions[key] = "Invalid";
      await expect(
        stamper.stamp({
          appId,
          slug: "feedly",
          label: "Feedly",
          spec,
          declarations,
          template: selectDisposableAppTemplate(spec, await stamper.templates()),
        }),
      ).rejects.toBeInstanceOf(ActionableError);
      expect(template.resolve).not.toHaveBeenCalled();
    },
  );

  test("refuses an unknown flavor before resolving the bundle", async () => {
    const { stamper, template } = harness();
    await expect(
      stamper.stamp({
        appId,
        slug: "feedly",
        label: "Feedly",
        spec,
        declarations: disposableAppDeclarations(spec),
        template: { name: "media", size: 2, capabilities: [] },
      }),
    ).rejects.toThrow("Unknown iOS disposable app template");
    expect(template.resolve).not.toHaveBeenCalled();
  });
});
