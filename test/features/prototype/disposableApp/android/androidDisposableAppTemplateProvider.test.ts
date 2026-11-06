import { expect, test } from "bun:test";
import {
  AndroidDisposableAppTemplateProvider,
  asDisposableAppTemplate,
} from "../../../../../src/features/prototype/disposableApp/android/androidDisposableAppTemplateProvider";
import { selectDisposableAppTemplate } from "../../../../../src/features/prototype/disposableApp/disposableAppTemplates";
import { FakeFileSystem } from "../../../../fakes/FakeFileSystem";
import { stampInput } from "./androidStamperFakes";

const variable = "AUTOMOBILE_ANDROID_PROTOTYPE_APP_TEMPLATE";
async function fixture(directory: string) {
  const fs = new FakeFileSystem();
  const input = stampInput();
  fs.setDirectory(directory);
  await fs.writeFileBuffer(`${directory}/template.apk`, Buffer.from("template"));
  fs.setFile(
    `${directory}/template.json`,
    JSON.stringify({
      template: "base",
      applicationId: input.template.templatePackage,
      apkSha256: input.template.apkSha256,
    }),
  );
  fs.setFile(`${directory}/capabilities.json`, '{"template":"base","capabilities":[]}');
  fs.setFile(`${directory}/AndroidManifest.xml`, input.template.manifestXml);
  return fs;
}
test("unset env explains unpublished release asset", async () => {
  await expect(
    new AndroidDisposableAppTemplateProvider(new FakeFileSystem(), {}).resolve(),
  ).rejects.toThrow("release asset is not published yet");
});
test("resolves a parent flavor directory and adapts for template selection", async () => {
  const provider = new AndroidDisposableAppTemplateProvider(await fixture("/templates/base"), {
    [variable]: "/templates",
  });
  const template = await provider.resolve();
  expect(template.apkPath).toBe("/templates/base/template.apk");
  expect(
    selectDisposableAppTemplate({ root: { type: "column" } }, [asDisposableAppTemplate(template)])
      .name,
  ).toBe("base");
});
test("resolves a direct flavor directory and checks APK checksum", async () => {
  const fs = await fixture("/templates/base");
  const provider = new AndroidDisposableAppTemplateProvider(fs, { [variable]: "/templates/base" });
  expect((await provider.resolve()).size).toBe(8);
  await fs.writeFileBuffer("/templates/base/template.apk", Buffer.from("changed"));
  await expect(provider.resolve()).rejects.toThrow("checksum mismatch");
});
