import { expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { parseStringPromise } from "xml2js";

const res = "android/protoviewer/src/main/res";
interface XmlNode {
  $: Record<string, string>;
  [key: string]: XmlNode[] | Record<string, string>;
}
async function xml(path: string): Promise<Record<string, XmlNode>> {
  return parseStringPromise(readFileSync(path, "utf8"));
}

test("adaptive launcher uses SVG foreground geometry and evenodd monochrome holes", async () => {
  const svg = (await xml("store-listing/icon/foreground.svg")).svg!;
  const source = (svg.path as XmlNode[])[0]!.$;
  expect(source["fill-rule"]).toBe("evenodd");
  for (const layer of ["foreground", "monochrome"]) {
    const vector = (await xml(`${res}/drawable/ic_launcher_${layer}.xml`)).vector!;
    expect(vector.$["android:viewportWidth"]).toBe("108");
    expect(vector.$["android:viewportHeight"]).toBe("108");
    expect((vector.path as XmlNode[])[0]!.$).toMatchObject({
      "android:pathData": source.d!,
      "android:fillColor": source.fill!,
      "android:fillType": "evenOdd",
    });
  }
  const background = (await xml("store-listing/icon/background.svg")).svg!;
  const vector = (await xml(`${res}/drawable/ic_launcher_background.xml`)).vector!;
  expect((vector.path as XmlNode[])[0]!.$["android:fillColor"]).toBe(
    (background.rect as XmlNode[])[0]!.$.fill,
  );
  expect((vector.path as XmlNode[])[0]!.$["android:pathData"]).toBe("M0 0h108v108H0z");
  const adaptive = (await xml(`${res}/mipmap/ic_launcher.xml`))["adaptive-icon"]!;
  for (const layer of ["foreground", "background", "monochrome"]) {
    expect((adaptive[layer] as XmlNode[])[0]!.$["android:drawable"]).toBe(
      `@drawable/ic_launcher_${layer}`,
    );
  }
  const manifest = (await xml("android/protoviewer/src/main/AndroidManifest.xml")).manifest!;
  expect((manifest.application as XmlNode[])[0]!.$["android:icon"]).toBe("@mipmap/ic_launcher");
  expect(existsSync(`${res}/drawable/ic_protoviewer.xml`)).toBe(false);
});
