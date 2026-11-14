import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  declaredTypes,
  findMissingTypes,
  loadProject,
  type TargetSources,
} from "../../scripts/ios/check-ctrl-proxy-target-types";

const SOURCES = new Map<string, string>([
  [
    "Sources/CtrlProxy/Models/HierarchyUpdateResponse.swift",
    "import Foundation\npublic struct HierarchyUpdateResponse: Codable {}\n",
  ],
  [
    "Sources/CtrlProxy/GestureCoordinateStrategy.swift",
    "struct GestureCoordinateGeometry: Equatable {\n    struct Node {}\n}\n",
  ],
  ["Wire/Sources/Wire/Envelope.swift", "public struct WireEnvelope {}\n"],
]);
const PACKAGES = new Map([["Wire", ["Wire/Sources/Wire/Envelope.swift"]]]);
const TV: TargetSources = {
  name: "CtrlProxyTVUITests",
  files: ["Sources/CtrlProxy/Models/HierarchyUpdateResponse.swift"],
  packages: ["Wire"],
};

function withResponse(body: string): Map<string, string> {
  return new Map([
    ...SOURCES,
    ["Sources/CtrlProxy/Models/HierarchyUpdateResponse.swift", `import Foundation\n${body}`],
  ]);
}

describe("declaredTypes", () => {
  test("separates top-level from nested declarations and ignores comments and strings", () => {
    const types = declaredTypes(
      'struct Outer {\n  enum Inner {}\n}\n// struct Commented {}\nlet s = "class Quoted"\nactor Worker {}\n',
    );
    expect([...types.topLevel].sort()).toEqual(["Outer", "Worker"]);
    expect([...types.all].sort()).toEqual(["Inner", "Outer", "Worker"]);
  });
});

describe("findMissingTypes", () => {
  test("reports a project type defined only in a file the target does not compile (#18342)", () => {
    const sources = withResponse(
      "public struct RefreshGeometryResponse {\n    let geometry: GestureCoordinateGeometry\n}\n",
    );
    expect(findMissingTypes([TV], sources, PACKAGES)).toEqual([
      {
        target: "CtrlProxyTVUITests",
        file: "Sources/CtrlProxy/Models/HierarchyUpdateResponse.swift",
        line: 3,
        type: "GestureCoordinateGeometry",
        definedIn: ["Sources/CtrlProxy/GestureCoordinateStrategy.swift"],
      },
    ]);
  });

  test("accepts the type once its defining file is in the target", () => {
    const sources = withResponse("struct R { let g: GestureCoordinateGeometry }\n");
    const target = {
      ...TV,
      files: [...TV.files, "Sources/CtrlProxy/GestureCoordinateStrategy.swift"],
    };
    expect(findMissingTypes([target], sources, PACKAGES)).toEqual([]);
  });

  test("accepts SDK types, package types, and the target's own nested types", () => {
    const sources = withResponse(
      "struct R {\n  struct Node {}\n  let n: Node\n  let e: WireEnvelope\n  let d: Data\n}\n",
    );
    expect(findMissingTypes([TV], sources, PACKAGES)).toEqual([]);
  });

  test("does not let another file's nested type hide a missing top-level type", () => {
    const sources = new Map([
      ["Own.swift", "struct Own {\n  struct Geometry {}\n}\n"],
      ["Use.swift", "struct Use {\n  let geometry: Geometry\n  let n: Own.Geometry\n}\n"],
      ["Geometry.swift", "struct Geometry {}\n"],
    ]);
    const target = { name: "T", files: ["Own.swift", "Use.swift"], packages: [] };
    expect(findMissingTypes([target], sources, new Map())).toEqual([
      { target: "T", file: "Use.swift", line: 2, type: "Geometry", definedIn: ["Geometry.swift"] },
    ]);
  });

  test("reports a package type when the target does not depend on the package", () => {
    const sources = withResponse("struct R { let e: WireEnvelope }\n");
    const missing = findMissingTypes([{ ...TV, packages: [] }], sources, PACKAGES);
    expect(missing.map((m) => m.type)).toEqual(["WireEnvelope"]);
  });

  test("ignores references in comments, strings and import lines", () => {
    const sources = withResponse(
      '@testable import GestureCoordinateGeometry\n// GestureCoordinateGeometry\nlet s = "GestureCoordinateGeometry"\n',
    );
    expect(findMissingTypes([TV], sources, PACKAGES)).toEqual([]);
  });
});

describe("loadProject", () => {
  const root = mkdtempSync(join(tmpdir(), "ctrl-proxy-target-types-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function write(path: string, text: string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }

  test("resolves file and directory sources, excludes, and local package dependencies", () => {
    const dir = join(root, "control-proxy");
    write(
      "control-proxy/project.yml",
      [
        "packages:",
        "  Wire:",
        "    path: ../wire",
        "targets:",
        "  TV:",
        "    sources:",
        "      - path: Tests/TV",
        "        excludes: ['Skip*.swift']",
        "      - Sources/CtrlProxy/Shared.swift",
        "    dependencies:",
        "      - package: Wire",
        "      - target: App",
        "",
      ].join("\n"),
    );
    write("control-proxy/Tests/TV/Router.swift", "struct Router { let g: Helper }\n");
    write("control-proxy/Tests/TV/SkipMe.swift", "struct SkipMe {}\n");
    write("control-proxy/Sources/CtrlProxy/Shared.swift", "struct Shared {}\n");
    write("control-proxy/Sources/CtrlProxy/Helper.swift", "struct Helper {}\n");
    write("wire/Sources/Wire/Envelope.swift", "public struct WireEnvelope {}\n");

    const { targets, sources, packageFiles } = loadProject(dir);
    expect(targets).toEqual([
      {
        name: "TV",
        files: ["Tests/TV/Router.swift", "Sources/CtrlProxy/Shared.swift"],
        packages: ["Wire"],
      },
    ]);
    expect(packageFiles.get("Wire")).toEqual(["../wire/Sources/Wire/Envelope.swift"]);
    expect(sources.has("Tests/TV/SkipMe.swift")).toBe(true);
    expect(findMissingTypes(targets, sources, packageFiles).map((m) => m.type)).toEqual(["Helper"]);
  });
});
