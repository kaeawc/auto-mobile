import { describe, expect, mock, test } from "bun:test";
import { posix } from "path";
import { hashAppBundle } from "../../../src/utils/ios-cmdline-tools/AppBundleHasher";

// ADD-8 (#4177 item 9): the previous suite drove `hashAppBundle` through the
// real filesystem (`fs.mkdtemp`) and leaked two temp trees per run. This
// replaces that with an in-memory `bundle()` seam implementing the hasher's
// injected filesystem dependencies — no real fs, no cleanup, and
// it lets us pin the full skip-list, rename sensitivity, and readdir-order
// independence that the fs-backed tests never covered.

interface BundleOptions {
  /** Return directory children in reverse-sorted order, to prove order-independence. */
  reverseReaddir?: boolean;
  symlinks?: Record<string, string>;
  externalFiles?: Record<string, string>;
  specialEntries?: string[];
}

const bundle = (root: string, files: Record<string, string>, options: BundleOptions = {}) => {
  const fileContents = new Map<string, string>(Object.entries(options.externalFiles ?? {}));
  const links = new Map(
    Object.entries(options.symlinks ?? {}).map(([rel, target]) => [`${root}/${rel}`, target]),
  );
  const specialEntries = new Set((options.specialEntries ?? []).map((rel) => `${root}/${rel}`));
  const dirs = new Set<string>([root, "/"]);
  for (const [rel, content] of Object.entries(files)) {
    fileContents.set(`${root}/${rel}`, content);
  }
  for (const full of [...fileContents.keys(), ...links.keys(), ...specialEntries]) {
    let parent = posix.dirname(full);
    while (parent !== "/") {
      dirs.add(parent);
      parent = posix.dirname(parent);
    }
  }

  const childrenOf = (dir: string): string[] => {
    const prefix = `${dir}/`;
    const names = new Set<string>();
    for (const p of [...fileContents.keys(), ...dirs, ...links.keys(), ...specialEntries]) {
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

  // node's join uses backslashes on Windows; fake keys use forward slashes.
  const norm = (p: string): string => p.replace(/\\/g, "/");
  const follow = (key: string): string => {
    const target = links.get(key);
    return target === undefined ? key : posix.resolve(posix.dirname(key), target);
  };
  return {
    readDir: mock(async (path: string): Promise<string[]> => {
      const key = norm(path);
      if (links.has(key)) {
        throw new Error(`readDir followed symlink: ${key}`);
      }
      return childrenOf(key);
    }),
    stat: mock(async (path: string) => {
      const key = follow(norm(path));
      return {
        isDirectory: () => dirs.has(key),
        isFile: () => fileContents.has(key),
      };
    }),
    lstat: mock(async (path: string) => {
      const key = norm(path);
      return {
        isDirectory: () => dirs.has(key),
        isFile: () => fileContents.has(key),
        isSymbolicLink: () => links.has(key),
      };
    }),
    readLink: mock(async (path: string): Promise<string> => {
      const target = links.get(norm(path));
      if (target === undefined) {
        throw new Error(`not a symlink: ${path}`);
      }
      return target;
    }),
    readFile: mock(async (path: string): Promise<Buffer> => {
      const key = follow(norm(path));
      const contents = fileContents.get(key);
      if (contents === undefined) {
        throw new Error(`not a regular file: ${path}`);
      }
      return Buffer.from(contents, "utf-8");
    }),
  };
};

const ROOT = "/AutoMobileTest.app";
const hashOf = (files: Record<string, string>, options?: BundleOptions): Promise<string> =>
  hashAppBundle(ROOT, bundle(ROOT, files, options));

const baseFiles: Record<string, string> = {
  "Info.plist": "info",
  AutoMobileTest: "mach-o-binary",
  "Frameworks/Lib.framework/Lib": "lib-binary",
};

describe("hashAppBundle", () => {
  // Computed with the unmodified origin/main e659ba1 implementation.
  test("preserves symlink-free legacy and length-prefixed digests", async () => {
    const deps = bundle(ROOT, baseFiles);
    expect(await hashAppBundle(ROOT, deps)).toBe(
      "ebebcc76b1114dca44d697ebe8acbe7a07137e4cbe43427a885956d3ea9a7175",
    );
    expect(await hashAppBundle(ROOT, deps, { lengthPrefixed: true })).toBe(
      "f4cf79a670eb62710d47a5cdfe55ca8bc7654671ff671f3637f8fd099fb5d443",
    );
  });

  test("seals file-to-symlink replacement while preserving the legacy contract", async () => {
    const file = bundle(ROOT, { a: "same" });
    const link = bundle(
      ROOT,
      {},
      {
        symlinks: { a: "/outside/a" },
        externalFiles: { "/outside/a": "same" },
      },
    );
    // Persisted legacy hashes intentionally follow links and remain byte-compatible.
    expect(await hashAppBundle(ROOT, file)).toBe(await hashAppBundle(ROOT, link));
    const options = { sealLinks: true };
    expect(await hashAppBundle(ROOT, file, options)).not.toBe(
      await hashAppBundle(ROOT, link, options),
    );
  });

  test("seals link target text without reading the target bytes", async () => {
    const first = bundle(ROOT, {}, { symlinks: { a: "/missing/one" } });
    const second = bundle(ROOT, {}, { symlinks: { a: "/missing/two" } });
    const options = { sealLinks: true };
    expect(await hashAppBundle(ROOT, first, options)).not.toBe(
      await hashAppBundle(ROOT, second, options),
    );
    expect(first.readLink).toHaveBeenCalledTimes(1);
    expect(first.readFile).not.toHaveBeenCalled();
    expect(first.stat).not.toHaveBeenCalled();
  });

  test.each(["Frameworks", "/outside", ".", ".."])(
    "never traverses a symlinked directory targeting %s",
    async (target) => {
      const deps = bundle(
        ROOT,
        { "Frameworks/lib": "inside" },
        {
          symlinks: { linked: target },
          externalFiles: { "/outside/secret": "outside" },
        },
      );
      await hashAppBundle(ROOT, deps, { sealLinks: true });
      expect(deps.readDir.mock.calls.map(([p]) => p.replace(/\\/g, "/"))).toEqual([
        ROOT,
        `${ROOT}/Frameworks`,
      ]);
      expect(deps.readFile.mock.calls.map(([p]) => p.replace(/\\/g, "/"))).toEqual([
        `${ROOT}/Frameworks/lib`,
      ]);
      expect(deps.stat).not.toHaveBeenCalled();
    },
  );

  test("seals special entries without opening them", async () => {
    const deps = bundle(ROOT, {}, { specialEntries: ["pipe"] });
    expect(await hashAppBundle(ROOT, deps, { sealLinks: true })).not.toBe(
      await hashAppBundle(ROOT, bundle(ROOT, {}), { sealLinks: true }),
    );
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(deps.readLink).not.toHaveBeenCalled();
  });

  test("rejects a symlinked bundle root before reading its directory", async () => {
    const deps = bundle(ROOT, {});
    deps.lstat.mockResolvedValue({
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => true,
    });
    await expect(hashAppBundle(ROOT, deps, { sealLinks: true })).rejects.toThrow(
      "root must be a real directory",
    );
    expect(deps.readDir).not.toHaveBeenCalled();
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  test("sealed hashes preserve skip-list and signing-metadata options", async () => {
    const plain = bundle(ROOT, baseFiles);
    const signed = bundle(ROOT, { ...baseFiles, "_CodeSignature/CodeResources": "signature" });
    expect(await hashAppBundle(ROOT, plain, { sealLinks: true })).toBe(
      await hashAppBundle(ROOT, signed, { sealLinks: true }),
    );
    const options = { sealLinks: true, includeSigningMetadata: true };
    expect(await hashAppBundle(ROOT, plain, options)).not.toBe(
      await hashAppBundle(ROOT, signed, options),
    );
  });

  test("sealLinks implies length framing for every field", async () => {
    const single = bundle(ROOT, { a: "X\0file\0b\0Y" });
    const pair = bundle(ROOT, { a: "X", b: "Y" });
    const options = { sealLinks: true, lengthPrefixed: false };
    expect(await hashAppBundle(ROOT, single, options)).not.toBe(
      await hashAppBundle(ROOT, pair, options),
    );
    expect(await hashAppBundle(ROOT, pair, options)).toBe(
      await hashAppBundle(ROOT, pair, { sealLinks: true, lengthPrefixed: true }),
    );
  });

  test("length framing distinguishes the legacy one-file/two-file collision", async () => {
    const single = bundle(ROOT, { a: "X\0b\0Y" });
    const pair = bundle(ROOT, { a: "X", b: "Y" });
    expect(await hashAppBundle(ROOT, single)).toBe(await hashAppBundle(ROOT, pair));
    const options = { includeSigningMetadata: true, lengthPrefixed: true };
    expect(await hashAppBundle(ROOT, single, options)).not.toBe(
      await hashAppBundle(ROOT, pair, options),
    );
  });

  test("is stable across repeated hashing of identical contents", async () => {
    expect(await hashOf(baseFiles)).toBe(await hashOf(baseFiles));
  });

  // Skip-list table: signing/packaging artifacts that vary between otherwise
  // identical builds must NOT change the hash.
  const skipArtifacts: ReadonlyArray<{ label: string; extra: Record<string, string> }> = [
    { label: "_CodeSignature contents", extra: { "_CodeSignature/CodeResources": "signature" } },
    { label: "SC_Info supplemental data", extra: { "SC_Info/AutoMobileTest.sinf": "sc-info" } },
    { label: "embedded.mobileprovision", extra: { "embedded.mobileprovision": "provision" } },
    { label: "PkgInfo", extra: { PkgInfo: "APPL????" } },
    {
      label: "a top-level .xcent entitlements blob",
      extra: { "AutoMobileTest.xcent": "entitlements" },
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

  for (const { label, extra } of skipArtifacts) {
    test(`includes ${label} when hashing a signed runner`, async () => {
      const original = await hashAppBundle(ROOT, bundle(ROOT, baseFiles), {
        includeSigningMetadata: true,
      });
      const changed = await hashAppBundle(ROOT, bundle(ROOT, { ...baseFiles, ...extra }), {
        includeSigningMetadata: true,
      });
      expect(changed).not.toBe(original);
    });
  }

  test("ignores all skip-list artifacts at once", async () => {
    const withAll = {
      ...baseFiles,
      "_CodeSignature/CodeResources": "signature",
      "SC_Info/AutoMobileTest.sinf": "sc-info",
      "embedded.mobileprovision": "provision",
      PkgInfo: "APPL????",
      "AutoMobileTest.xcent": "entitlements",
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
    const swapped = { ...baseFiles, "Info.plist": "mach-o-binary", AutoMobileTest: "info" };
    expect(await hashOf(swapped)).not.toBe(await hashOf(baseFiles));
  });
});
