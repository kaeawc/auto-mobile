import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { load } from "js-yaml";

/**
 * A target that depends on a local package which `@_exported import`s another local
 * package must declare that second package too. Xcode links only the products a
 * target names, so the re-exported module still compiles (its swiftmodule is visible
 * through the re-export) but its non-inlinable symbols are missing at link time:
 * `ios-playground-tests` failed with `Undefined symbol: AutoMobileSdkWire...` once the
 * Playground started calling wire initializers directly.
 */

const IOS_DIR = resolve(import.meta.dir, "../../ios");

type XcodegenSpec = {
  packages?: Record<string, { path?: string }>;
  targets?: Record<string, { dependencies?: Array<{ package?: string }> }>;
};

export type Violation = { target: string; missing: string; via: string };

/** Every `package:` dependency a spec declares per target, minus packages already present. */
export function findMissingReexportedPackages(
  spec: XcodegenSpec,
  reexportsOf: (packageName: string) => string[],
): Violation[] {
  const violations: Violation[] = [];
  for (const [target, config] of Object.entries(spec.targets ?? {})) {
    const declared = new Set(
      (config.dependencies ?? []).flatMap((dep) => (dep.package ? [dep.package] : [])),
    );
    for (const via of declared) {
      for (const missing of reexportsOf(via)) {
        if (!declared.has(missing)) {
          violations.push({ target, missing, via });
        }
      }
    }
  }
  return violations;
}

function swiftFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === ".build" ? [] : swiftFiles(full);
    }
    return entry.name.endsWith(".swift") ? [full] : [];
  });
}

/** Modules a local package re-exports, mapped back to the spec's package names. */
function realReexportsOf(projectDir: string, spec: XcodegenSpec) {
  const moduleToPackage = new Map<string, string>();
  for (const [name, pkg] of Object.entries(spec.packages ?? {})) {
    if (pkg.path) {
      moduleToPackage.set(name, name);
    }
  }
  return (packageName: string): string[] => {
    const path = spec.packages?.[packageName]?.path;
    if (!path) {
      return [];
    }
    const sources = join(resolve(projectDir, path), "Sources");
    const exported = swiftFiles(sources).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/^\s*@_exported\s+import\s+(\w+)/gm)].map(
        (match) => match[1],
      ),
    );
    return [...new Set(exported)].flatMap((mod) => {
      const owner = moduleToPackage.get(mod);
      return owner && owner !== packageName ? [owner] : [];
    });
  };
}

describe("xcodegen project.yml re-exported package dependencies", () => {
  test("flags a target that depends on a re-exporting package but not the re-exported one", () => {
    const spec: XcodegenSpec = {
      targets: { App: { dependencies: [{ package: "Sdk" }] } },
    };
    expect(findMissingReexportedPackages(spec, (name) => (name === "Sdk" ? ["Wire"] : []))).toEqual(
      [{ target: "App", missing: "Wire", via: "Sdk" }],
    );
  });

  test("accepts a target that declares both packages", () => {
    const spec: XcodegenSpec = {
      targets: { App: { dependencies: [{ package: "Sdk" }, { package: "Wire" }] } },
    };
    expect(findMissingReexportedPackages(spec, (name) => (name === "Sdk" ? ["Wire"] : []))).toEqual(
      [],
    );
  });

  test("every committed project.yml declares the packages its dependencies re-export", () => {
    const violations = readdirSync(IOS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const projectDir = join(IOS_DIR, entry.name);
        try {
          const spec = load(readFileSync(join(projectDir, "project.yml"), "utf8")) as XcodegenSpec;
          return findMissingReexportedPackages(spec, realReexportsOf(projectDir, spec)).map(
            (v) =>
              `${entry.name}: target ${v.target} needs package ${v.missing} (re-exported by ${v.via})`,
          );
        } catch (error) {
          // Directories without a project.yml (plain Swift packages) are not XcodeGen projects.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
          }
          throw error;
        }
      });
    expect(violations).toEqual([]);
  });
});
