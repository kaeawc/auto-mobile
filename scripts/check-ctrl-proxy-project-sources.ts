import { readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { load } from "js-yaml";
import { sortedReaddirEntries } from "../src/utils/io";

type Source = string | { path: string; excludes?: string[] };
type Project = { targets?: Record<string, { sources?: Source[] }> };

const projectDir = process.argv[2];
if (!projectDir) {
  throw new Error("CtrlProxy project directory is required");
}

const yaml = load(await readFile(join(projectDir, "project.yml"), "utf8")) as Project;
if (!yaml?.targets || typeof yaml.targets !== "object") {
  throw new Error("project.yml has no targets");
}

const swiftFiles = new Set<string>();
async function collect(path: string, sourceRoot: string, excludes: string[]): Promise<void> {
  const absolute = join(projectDir, path);
  const entry = await stat(absolute);
  if (entry.isDirectory()) {
    for (const child of await sortedReaddirEntries(absolute)) {
      const childPath = join(path, child.name);
      const relativeChild = relative(sourceRoot, childPath);
      if (
        excludes.some(
          (pattern) =>
            new Bun.Glob(pattern).match(relativeChild) || new Bun.Glob(pattern).match(child.name),
        )
      ) {
        continue;
      }
      await collect(childPath, sourceRoot, excludes);
    }
  } else if (entry.isFile() && path.endsWith(".swift")) {
    swiftFiles.add(path);
  }
}

for (const [target, config] of Object.entries(yaml.targets)) {
  if (!Array.isArray(config.sources)) {
    continue;
  }
  for (const source of config.sources) {
    const path = typeof source === "string" ? source : source?.path;
    const excludes = typeof source === "string" ? [] : (source.excludes ?? []);
    if (typeof path !== "string" || !Array.isArray(excludes)) {
      throw new Error(`Invalid source path in target ${target}`);
    }
    await collect(path, path, excludes);
  }
}

const pbxproj = await readFile(join(projectDir, "CtrlProxy.xcodeproj/project.pbxproj"), "utf8");
const fileReferences = pbxproj
  .split("/* Begin PBXFileReference section */")[1]
  ?.split("/* End PBXFileReference section */")[0];
if (!fileReferences) {
  throw new Error("project.pbxproj has no PBXFileReference section");
}

// XcodeGen writes one PBXFileReference per Swift source. Count identical names
// so a different source with the same basename cannot mask an omitted file.
const referenceCounts = new Map<string, number>();
for (const line of fileReferences.split("\n")) {
  if (!line.includes("lastKnownFileType = sourcecode.swift;")) {
    continue;
  }
  const value = line
    .match(/(?:^|; )path = (?:"((?:[^"\\]|\\.)*)"|([^;]+));/)
    ?.slice(1)
    .find(Boolean);
  if (value) {
    referenceCounts.set(value, (referenceCounts.get(value) ?? 0) + 1);
  }
}

const requiredCounts = new Map<string, number>();
for (const file of swiftFiles) {
  const name = basename(file);
  requiredCounts.set(name, (requiredCounts.get(name) ?? 0) + 1);
}
const missing = [...requiredCounts].filter(
  ([name, count]) => (referenceCounts.get(name) ?? 0) < count,
);
if (missing.length) {
  for (const [name, count] of missing) {
    console.error(
      `CtrlProxy project.pbxproj is missing ${name}: ${referenceCounts.get(name) ?? 0}/${count} Swift file references`,
    );
  }
  process.exit(1);
}
console.log(
  `CtrlProxy project.pbxproj references all ${swiftFiles.size} Swift files declared by project.yml sources`,
);
