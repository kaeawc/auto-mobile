import { expect, test } from "bun:test";
import { stampAndroidManifest } from "../../../../../src/features/prototype/disposableApp/android/androidStampManifest";
import { ActionableError } from "../../../../../src/models/ActionableError";
import { parseStringPromise } from "xml2js";

// Captured-shaped inline copy; the verbatim AGP output lives in test/fixtures/android-stamp.
export const templatePackage = "dev.jasonpearson.automobile.app.template";
export const templateXml = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${templatePackage}" android:compileSdkVersion="37" platformBuildVersionCode="37">
<uses-sdk android:minSdkVersion="26" android:targetSdkVersion="37"/>
<uses-permission android:name="android.permission.INTERNET"/><uses-permission android:name="android.permission.CAMERA"/>
<uses-permission-sdk-23 android:name="android.permission.READ_CONTACTS"/>
<application android:icon="@mipmap/ic_launcher" android:label="@string/app_name" android:theme="@style/Theme.PrototypeApp.Splash">
<activity android:name="dev.jasonpearson.automobile.prototype.appshell.PrototypeAppActivity" android:enabled="false"><intent-filter><action android:name="android.intent.action.MAIN"/></intent-filter></activity>
<provider android:name="androidx.startup.InitializationProvider" android:authorities="${templatePackage}.androidx-startup"/>
<meta-data android:name="platform" android:resource="@android:style/Theme"/><meta-data android:name="private" android:resource="@*android:style/Theme"/><meta-data android:name="id" android:resource="@0x7f080000"/>
</application></manifest>`;
const input = {
  templatePackage,
  appId: "dev.jasonpearson.automobile.app.feedly",
  label: 'Feedly & "News"',
  permissions: ["android.permission.POST_NOTIFICATIONS", "android.permission.INTERNET"],
  enabledComponents: ["dev.jasonpearson.automobile.prototype.appshell.PrototypeAppActivity"],
};

test("stamps package, authorities, literal label, resources, exact permissions and component", async () => {
  const text = await stampAndroidManifest(templateXml, input);
  const parsed = await parseStringPromise(text);
  expect(parsed.manifest.$.package).toBe(input.appId);
  const app = parsed.manifest.application[0];
  expect(app.$["android:label"]).toBe(input.label);
  expect(app.provider[0].$["android:authorities"]).toBe(`${input.appId}.androidx-startup`);
  expect(app.$["android:icon"]).toBe(`@*${templatePackage}:mipmap/ic_launcher`);
  expect(app.$["android:theme"]).toBe(`@*${templatePackage}:style/Theme.PrototypeApp.Splash`);
  expect(
    app["meta-data"].map((node: { $: Record<string, string> }) => node.$["android:resource"]),
  ).toEqual(["@android:style/Theme", "@*android:style/Theme", "@0x7f080000"]);
  expect(
    parsed.manifest["uses-permission"].map(
      (node: { $: Record<string, string> }) => node.$["android:name"],
    ),
  ).toEqual(["android.permission.INTERNET", "android.permission.POST_NOTIFICATIONS"]);
  expect(parsed.manifest["uses-permission-sdk-23"]).toBeUndefined();
  expect(app.activity[0].$["android:enabled"]).toBe("true");
  expect(text).not.toContain("compileSdk");
  expect(text).not.toContain("platformBuild");
  expect(await stampAndroidManifest(templateXml, input)).toBe(text);
});
test("refuses an unknown component", async () => {
  expect(
    stampAndroidManifest(templateXml, { ...input, enabledComponents: ["unknown"] }),
  ).rejects.toBeInstanceOf(ActionableError);
});
test("preserves explicitly qualified template resource ownership", async () => {
  expect(
    await stampAndroidManifest(
      templateXml.replace("@mipmap/ic_launcher", `@${templatePackage}:mipmap/ic_launcher`),
      input,
    ),
  ).toContain(`@*${templatePackage}:mipmap/ic_launcher`);
});
test("keeps the special @null and @empty values unqualified", async () => {
  const xml = templateXml
    .replace('android:icon="@mipmap/ic_launcher"', 'android:icon="@null"')
    .replace('android:resource="@0x7f080000"', 'android:resource="@empty"');
  const parsed = await parseStringPromise(await stampAndroidManifest(xml, input));
  const app = parsed.manifest.application[0];
  expect(app.$["android:icon"]).toBe("@null");
  expect(
    app["meta-data"].map((node: { $: Record<string, string> }) => node.$["android:resource"]),
  ).toContain("@empty");
});
