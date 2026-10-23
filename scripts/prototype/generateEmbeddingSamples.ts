#!/usr/bin/env bun
/**
 * Regenerates the prototype embedding samples (#13732) from the `automobile:prototype/native`
 * resource itself, so the committed samples are exactly what an agent would receive.
 *
 *   bun scripts/prototype/generateEmbeddingSamples.ts          # write the samples
 *   bun scripts/prototype/generateEmbeddingSamples.ts --check  # fail if they drifted
 *
 * Android files land in samples/prototype-embedding/android (the consumer check in
 * scripts/android/validate-prototype-compose-consumer.sh compiles them against the published
 * renderer). The SwiftUI host lands in the EmbedConsumer fixture that the iOS library build
 * compiles (scripts/ios/prototype-library-build.sh).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import {
  readNativePrototype,
  type NativePrototypeSources,
} from "../../src/features/prototype/nativePrototype";
import { prototypeSpecSchema } from "../../src/features/prototype/prototypeSpec";

const REPO = path.join(import.meta.dir, "../..");
export const SAMPLE_SPEC_PATH = "test/fixtures/prototype-embedding/sample.json";
export const ANDROID_SAMPLE_ROOT = "samples/prototype-embedding/android";
export const IOS_SAMPLE_ROOT = "samples/prototype-embedding/ios";
export const IOS_FIXTURE_SOURCES =
  "ios/prototype-agent/Fixtures/EmbedConsumer/Sources/EmbedConsumer";
/** The version written into samples; pinned so samples do not churn on every release. */
export const SAMPLE_LIBRARY_VERSION = "0.0.0-sample";

/**
 * The sample is served as a saved prototype whose image has a known type but no bytes, so the
 * generated host references `hero.png` and the resource notes that the app must supply it.
 */
function sampleSources(spec: unknown): NativePrototypeSources {
  const parsed = prototypeSpecSchema.parse(spec);
  return {
    shownSpec: () => ({ kind: "unknown" }),
    devicesShowing: () => ["sample"],
    savedPrototypes: async () => [
      {
        id: parsed.id,
        spec: parsed,
        label: "Embedding sample",
        assets: [{ id: "hero", mimeType: "image/png" }],
      },
    ],
    platformOf: async () => undefined,
    libraryVersion: () => SAMPLE_LIBRARY_VERSION,
  };
}

/** Repository-relative path to file content for every generated sample file. */
export async function renderEmbeddingSamples(spec: unknown): Promise<Map<string, string>> {
  const sources = sampleSources(spec);
  const id = prototypeSpecSchema.parse(spec).id;
  const files = new Map<string, string>();
  const android = await readNativePrototype({ id, platform: "android" }, sources);
  for (const file of android.files) {
    files.set(`${ANDROID_SAMPLE_ROOT}/${file.path}`, `${file.content.trimEnd()}\n`);
  }
  const ios = await readNativePrototype({ id, platform: "ios" }, sources);
  for (const file of ios.files) {
    // The host compiles inside the fixture target; the spec ships with the iOS sample layout.
    const target = file.path.endsWith(".swift")
      ? `${IOS_FIXTURE_SOURCES}/${file.path}`
      : `${IOS_SAMPLE_ROOT}/${file.path}`;
    files.set(target, `${file.content.trimEnd()}\n`);
  }
  return files;
}

function readSampleSpec(): unknown {
  return JSON.parse(readFileSync(path.join(REPO, SAMPLE_SPEC_PATH), "utf8"));
}

/** Paths whose committed content differs from a fresh render. */
export async function driftedEmbeddingSamples(): Promise<string[]> {
  const files = await renderEmbeddingSamples(readSampleSpec());
  return [...files]
    .filter(([relative, content]) => {
      const absolute = path.join(REPO, relative);
      return !existsSync(absolute) || readFileSync(absolute, "utf8") !== content;
    })
    .map(([relative]) => relative);
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    const drifted = await driftedEmbeddingSamples();
    if (drifted.length > 0) {
      console.error(
        `Embedding samples are stale; run bun ${path.relative(REPO, import.meta.path)}:\n${drifted.join("\n")}`,
      );
      process.exit(1);
    }
    console.log("Embedding samples match the native resource output.");
    return;
  }
  for (const [relative, content] of await renderEmbeddingSamples(readSampleSpec())) {
    const absolute = path.join(REPO, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    console.log(`wrote ${relative}`);
  }
}

if (import.meta.main) {
  await main();
}
