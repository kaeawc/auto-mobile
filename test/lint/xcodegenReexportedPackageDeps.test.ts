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

/**
 * Maps the modules a package re-exports to the spec package names a target must also
 * declare. A module that is one of the package's own targets, or that is not a local
 * package module at all (system/remote), needs nothing. A local module whose package
 * the spec never declares under `packages:` is still reported, under a descriptive
 * name, because the target cannot depend on it until the package is declared.
 */
export function requiredPackagesForReexports(
  exportedModules: string[],
  ownModules: ReadonlySet<string>,
  localModuleDirs: ReadonlyMap<string, string>,
  specPackageByDir: ReadonlyMap<string, string>,
): string[] {
  return [...new Set(exportedModules)].flatMap((mod) => {
    const dir = localModuleDirs.get(mod);
    if (ownModules.has(mod) || dir === undefined) {
      return [];
    }
    return [specPackageByDir.get(dir) ?? `${mod} (from ${dir}, undeclared in packages:)`];
  });
}

function hasPackageManifest(dir: string): boolean {
  return readdirSync(dir).includes("Package.swift");
}

function sourceModules(packageDir: string): string[] {
  try {
    return readdirSync(join(packageDir, "Sources"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    // A Swift package without a Sources directory defines no local modules.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/** Every module under `ios/<package>/Sources/<Module>`, mapped to its package directory. */
function localModuleDirectories(): Map<string, string> {
  const modules = new Map<string, string>();
  for (const entry of readdirSync(IOS_DIR, { withFileTypes: true })) {
    const packageDir = join(IOS_DIR, entry.name);
    if (entry.isDirectory() && hasPackageManifest(packageDir)) {
      for (const mod of sourceModules(packageDir)) {
        modules.set(mod, packageDir);
      }
    }
  }
  return modules;
}

/** Spec package names a local package's `@_exported import`s require alongside it. */
function realReexportsOf(projectDir: string, spec: XcodegenSpec) {
  const localModuleDirs = localModuleDirectories();
  const specPackageByDir = new Map<string, string>();
  for (const [name, pkg] of Object.entries(spec.packages ?? {})) {
    if (pkg.path) {
      specPackageByDir.set(resolve(projectDir, pkg.path), name);
    }
  }
  return (packageName: string): string[] => {
    const path = spec.packages?.[packageName]?.path;
    if (!path) {
      return [];
    }
    const packageDir = resolve(projectDir, path);
    const exported = swiftFiles(join(packageDir, "Sources")).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/^\s*@_exported\s+import\s+(\w+)/gm)].map(
        (match) => match[1],
      ),
    );
    return requiredPackagesForReexports(
      exported,
      new Set(sourceModules(packageDir)),
      localModuleDirs,
      specPackageByDir,
    );
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

  test("maps a re-exported local module to the spec package declared for its directory", () => {
    expect(
      requiredPackagesForReexports(
        ["Wire", "Foundation", "SdkInternal"],
        new Set(["Sdk", "SdkInternal"]),
        new Map([
          ["Wire", "/ios/wire"],
          ["Sdk", "/ios/sdk"],
          ["SdkInternal", "/ios/sdk"],
        ]),
        new Map([
          ["/ios/wire", "WirePackage"],
          ["/ios/sdk", "Sdk"],
        ]),
      ),
    ).toEqual(["WirePackage"]);
  });

  test("reports a re-exported local module whose package the spec never declares", () => {
    const required = requiredPackagesForReexports(
      ["Wire"],
      new Set(["Sdk"]),
      new Map([["Wire", "/ios/wire"]]),
      new Map([["/ios/sdk", "Sdk"]]),
    );
    expect(required).toEqual(["Wire (from /ios/wire, undeclared in packages:)"]);
    const spec: XcodegenSpec = {
      targets: { App: { dependencies: [{ package: "Sdk" }] } },
    };
    expect(findMissingReexportedPackages(spec, (name) => (name === "Sdk" ? required : []))).toEqual(
      [{ target: "App", missing: required[0], via: "Sdk" }],
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
