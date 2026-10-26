import { describe, expect, test } from "bun:test";
import {
  buildNotices,
  collectDependencies,
  inputDigest,
  main,
  licenseFileName,
  parsePackageTree,
  recordedDigest,
  renderFromSources,
  renderNotices,
} from "../../scripts/ios/protoviewer-notices";
import firstPartyOnly from "../fixtures/protoviewer-notices/show-dependencies-first-party-only.json";
import withDependency from "../fixtures/protoviewer-notices/show-dependencies-with-dependency.json";

const rootLicense = "Apache License\nVersion 2.0\n";
const argumentParserLicense = "Apache-2.0 text for swift-argument-parser\n";

describe("ProtoViewer iOS notices", () => {
  test("a first-party-only graph yields just the AutoMobile notice", () => {
    const notices = buildNotices({
      root: parsePackageTree(firstPartyOnly),
      firstPartyLicense: rootLicense,
      licenseTexts: {},
    });
    expect(notices).toEqual([
      {
        id: "first-party:auto-mobile",
        name: "AutoMobile ProtoViewer",
        detail: "Apache License 2.0",
        license: "Apache License\nVersion 2.0",
      },
    ]);
  });

  test("a linked package needs its license text and is listed with version and source", () => {
    const root = parsePackageTree(withDependency);
    expect(collectDependencies(root).map((dep) => dep.identity)).toEqual([
      "swift-argument-parser",
      "swift-log",
    ]);
    const notices = buildNotices({
      root,
      firstPartyLicense: rootLicense,
      licenseTexts: {
        "swift-argument-parser.txt": argumentParserLicense,
        "swift-log.txt": "swift-log license\r\n",
      },
    });
    expect(notices[2]).toEqual({
      id: "swift-log",
      name: "swift-log",
      detail: "https://github.com/apple/swift-log.git",
      license: "swift-log license",
    });
    expect(notices[1]).toEqual({
      id: "swift-argument-parser",
      name: "swift-argument-parser",
      detail: "1.5.0 · https://github.com/apple/swift-argument-parser.git",
      license: "Apache-2.0 text for swift-argument-parser",
    });
  });

  test("a linked package without license text fails, naming the file to add", () => {
    expect(() =>
      buildNotices({
        root: parsePackageTree(withDependency),
        firstPartyLicense: rootLicense,
        licenseTexts: { "swift-argument-parser.txt": "  \n", "swift-log.txt": "text" },
      }),
    ).toThrow("Missing license text");
    expect(() =>
      buildNotices({
        root: parsePackageTree(withDependency),
        firstPartyLicense: rootLicense,
        licenseTexts: {},
      }),
    ).toThrow("swift-argument-parser.txt");
  });

  test("license text for a package that is no longer linked fails as stale", () => {
    expect(() =>
      buildNotices({
        root: parsePackageTree(firstPartyOnly),
        firstPartyLicense: rootLicense,
        licenseTexts: { "gone.txt": "text" },
      }),
    ).toThrow("no longer links: gone.txt");
  });

  test("transitive packages are deduplicated and local path packages are skipped", () => {
    const leaf = {
      identity: "leaf",
      name: "Leaf",
      url: "https://example.test/leaf.git",
      version: "2.0.0",
      dependencies: [],
    };
    const local = {
      identity: "local",
      name: "Local",
      url: "/work/local",
      version: "unspecified",
      dependencies: [leaf],
    };
    const mid = {
      identity: "mid",
      name: "Mid",
      url: "https://example.test/mid.git",
      version: "1.0.0",
      dependencies: [leaf],
    };
    const ssh = {
      identity: "ssh-pin",
      name: "Ssh",
      url: "git@github.com:o/r.git",
      version: "unspecified",
      dependencies: [],
    };
    const root = {
      identity: "root",
      name: "Root",
      url: "/work/root",
      version: "unspecified",
      dependencies: [mid, local, ssh],
    };
    expect(collectDependencies(root).map((dep) => dep.identity)).toEqual([
      "leaf",
      "mid",
      "ssh-pin",
    ]);
  });

  test("malformed dependency output and unsafe identities are rejected", () => {
    expect(() => parsePackageTree({ identity: "x" })).toThrow("expected identity");
    expect(() => parsePackageTree([])).toThrow("expected an object");
    expect(() => licenseFileName("../etc/passwd")).toThrow("safe license file name");
  });

  test("license text with control characters is rejected", () => {
    expect(() =>
      buildNotices({
        root: parsePackageTree(withDependency),
        firstPartyLicense: rootLicense,
        licenseTexts: { "swift-argument-parser.txt": "a\u0000b", "swift-log.txt": "ok" },
      }),
    ).toThrow("control character");
  });

  test("raw literals cannot be terminated or interpolated by license text", () => {
    const rendered = renderNotices(
      [{ id: "a", name: 'Quote "n" \\ slash', detail: "d", license: 'ends """# here and \\#(x)' }],
      "digest",
    );
    expect(rendered).toContain('name: "Quote \\"n\\" \\\\ slash"');
    expect(rendered).toContain('##"""\nends """# here and \\#(x)\n"""##');
  });

  test("rendering is deterministic and ends with the closing bracket and a newline", () => {
    const sources = {
      manifest: "// Package.swift",
      dependencyTree: withDependency,
      rootLicense,
      licenseTexts: {
        "swift-argument-parser.txt": argumentParserLicense,
        "swift-log.txt": "swift-log license",
      },
    };
    const rendered = renderFromSources(sources);
    expect(renderFromSources(sources)).toBe(rendered);
    expect(rendered.endsWith("]\n")).toBe(true);
    expect(rendered).toContain('id: "swift-argument-parser"');
  });

  test("the input digest changes with the manifest, root license or any license text", () => {
    const base = { manifest: "m", rootLicense: "r", licenseTexts: { "a.txt": "a" } };
    const digest = inputDigest(base);
    expect(inputDigest({ ...base })).toBe(digest);
    expect(inputDigest({ ...base, manifest: "m2" })).not.toBe(digest);
    expect(inputDigest({ ...base, rootLicense: "r2" })).not.toBe(digest);
    expect(inputDigest({ ...base, licenseTexts: { "a.txt": "b" } })).not.toBe(digest);
    expect(inputDigest({ ...base, licenseTexts: { "a.txt": "a", "b.txt": "b" } })).not.toBe(digest);
    expect(inputDigest({ ...base, manifest: "m\r\n" })).toBe(
      inputDigest({ ...base, manifest: "m\n" }),
    );
  });

  test("the digest is recorded in the output header and read back", () => {
    const rendered = renderNotices([], "abc123");
    expect(recordedDigest(rendered)).toBe("abc123");
    expect(recordedDigest("no header")).toBeUndefined();
  });

  test("a non-macOS host checks the committed output against its input digest", () => {
    expect(main(["--check"], "linux")).toBe(0);
    expect(main([], "linux")).toBe(1);
  });
});
