import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as samples from "../../../scripts/prototype/generateEmbeddingSamples";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";

const repo = path.join(import.meta.dir, "../../..");
const sampleDirectories = [
  `${samples.ANDROID_SAMPLE_ROOT}/app/src/main/assets/prototypes/embeddingSample`,
  `${samples.IOS_SAMPLE_ROOT}/Prototypes/embeddingSample`,
];

for (const directory of sampleDirectories) {
  test(`${directory} ships a 96x96 hero PNG`, () => {
    const png = readFileSync(path.join(repo, directory, "hero.png"));
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.readUInt32BE(8)).toBe(13);
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(96);
    expect(png.readUInt32BE(20)).toBe(96);
  });
}

test("sample requests use each platform's host address", () => {
  const urls = sampleDirectories.map((directory) => {
    const spec = prototypeSpecSchema.parse(
      JSON.parse(readFileSync(path.join(repo, directory, "spec.json"), "utf8")),
    );
    if (spec.root.type !== "column") {
      throw new Error("Expected sample column");
    }
    return spec.root.children.flatMap((node) =>
      node.type === "button"
        ? (node.onTap ?? []).flatMap((action) => (action.type === "request" ? [action.url] : []))
        : [],
    );
  });
  expect(samples.IOS_SAMPLE_REQUEST_URL).toBe("http://192.168.1.10:8080/greeting");
  expect(urls).toEqual([["http://10.0.2.2:8080/greeting"], [samples.IOS_SAMPLE_REQUEST_URL]]);
});

// The committed embedding samples are the automobile:prototype/native resource's own output
// (#13732) and the automobile:prototype/eject scaffold (#16499), so CI compiles exactly what an
// agent receives. Regenerate them with
// `bun scripts/prototype/generateEmbeddingSamples.ts` after a template or emitter change.
test("committed embedding samples match the native resource output", async () => {
  expect(await samples.driftedEmbeddingSamples()).toEqual([]);
});
