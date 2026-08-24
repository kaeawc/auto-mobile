import { describe, expect, test } from "bun:test";
import { hashAppBundle } from "../../../src/utils/ios-cmdline-tools/AppBundleHasher";

// ADD-8 (#4177 item 9): the previous suite drove `hashAppBundle` through the
// real filesystem (`fs.mkdtemp`) and leaked two temp trees per run. This
// replaces that with an in-memory `bundle()` seam implementing the hasher's
// injected {readDir, stat, readFile} dependencies — no real fs, no cleanup, and
// it lets us pin the full skip-list, rename sensitivity, and readdir-order
// independence that the fs-backed tests never covered.

interface BundleOptions {
  /** Return directory children in reverse-sorted order, to prove order-independence. */
  reverseReaddir?: boolean;
}

const bundle = (root: string, files: Record<string, string>, options: BundleOptions = {}) => {
  const fileContents = new Map<string, string>();
  const dirs = new Set<string>([root]);
  for (const [rel, content] of Object.entries(files)) {
    const full = `${root}/${rel}`;
    fileContents.set(full, content);
    const parts = rel.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = `${cur}/${parts[i]}`;
      dirs.add(cur);
    }
  }

  const childrenOf = (dir: string): string[] => {
    const prefix = `${dir}/`;
    const names = new Set<string>();
    for (const p of [...fileContents.keys(), ...dirs]) {
      if (p === dir || !p.startsWith(prefix)) {
        continue;
      }
      const name = p.slice(prefix.length).split("/")[0];
      if (name) {
        names.add(name);
      }
    }
    const sorted = [...names].sort();
    return options.reverseReaddir ? sorted.reverse() : sorted;
  };

  // The hasher builds the paths it passes here with node's `join` (see
  // AppBundleHasher.ts), so on Windows they arrive back-slash-separated while our
  // keys are forward-slash. Normalize on lookup so the in-memory seam matches on
  // every platform (the hasher already normalizes separators for the hash itself).
  const norm = (p: string): string => p.replace(/\\/g, "/");
  return {
    readDir: async (path: string): Promise<string[]> => childrenOf(norm(path)),
    stat: async (path: string) => {
      const key = norm(path);
      return {
        isDirectory: () => dirs.has(key),
        isFile: () => fileContents.has(key),
      };
    },
    readFile: async (path: string): Promise<Buffer> =>
      Buffer.from(fileContents.get(norm(path)) ?? "", "utf-8"),
  };
};

const ROOT = "/CtrlProxyApp.app";
const hashOf = (files: Record<string, string>, options?: BundleOptions): Promise<string> =>
  hashAppBundle(ROOT, bundle(ROOT, files, options));

const baseFiles: Record<string, string> = {
  "Info.plist": "info",
  CtrlProxyApp: "mach-o-binary",
  "Frameworks/Lib.framework/Lib": "lib-binary",
};

describe("hashAppBundle", () => {
  test("is stable across repeated hashing of identical contents", async () => {
    expect(await hashOf(baseFiles)).toBe(await hashOf(baseFiles));
  });

  // Skip-list table: signing/packaging artifacts that vary between otherwise
  // identical builds must NOT change the hash.
  const skipArtifacts: ReadonlyArray<{ label: string; extra: Record<string, string> }> = [
    { label: "_CodeSignature contents", extra: { "_CodeSignature/CodeResources": "signature" } },
    { label: "SC_Info supplemental data", extra: { "SC_Info/CtrlProxyApp.sinf": "sc-info" } },
    { label: "embedded.mobileprovision", extra: { "embedded.mobileprovision": "provision" } },
    { label: "PkgInfo", extra: { PkgInfo: "APPL????" } },
    {
      label: "a top-level .xcent entitlements blob",
      extra: { "CtrlProxyApp.xcent": "entitlements" },
    },
    {
      label: "a nested .xcent entitlements blob",
      extra: { "Frameworks/Lib.xcent": "entitlements" },
    },
  ];

  for (const { label, extra } of skipArtifacts) {
    test(`ignores ${label}`, async () => {
      expect(await hashOf({ ...baseFiles, ...extra })).toBe(await hashOf(baseFiles));
    });
  }

  test("ignores all skip-list artifacts at once", async () => {
    const withAll = {
      ...baseFiles,
      "_CodeSignature/CodeResources": "signature",
      "SC_Info/CtrlProxyApp.sinf": "sc-info",
      "embedded.mobileprovision": "provision",
      PkgInfo: "APPL????",
      "CtrlProxyApp.xcent": "entitlements",
    };
    expect(await hashOf(withAll)).toBe(await hashOf(baseFiles));
  });

  test("changes when a hashed file's contents change", async () => {
    const changed = { ...baseFiles, "Info.plist": "info-v2" };
    expect(await hashOf(changed)).not.toBe(await hashOf(baseFiles));
  });

  test("is sensitive to a rename (the relative path is part of the hash)", async () => {
    const renamed = {
      "Info.plist": "info",
      Renamed: "mach-o-binary",
      "Frameworks/Lib.framework/Lib": "lib-binary",
    };
    // Same byte contents, different file name → different hash.
    expect(await hashOf(renamed)).not.toBe(await hashOf(baseFiles));
  });

  test("is independent of readdir order (entries are sorted before hashing)", async () => {
    expect(await hashOf(baseFiles, { reverseReaddir: true })).toBe(await hashOf(baseFiles));
  });

  test("distinguishes two files with swapped contents (position is not conflated)", async () => {
    const swapped = { ...baseFiles, "Info.plist": "mach-o-binary", CtrlProxyApp: "info" };
    expect(await hashOf(swapped)).not.toBe(await hashOf(baseFiles));
  });
});
