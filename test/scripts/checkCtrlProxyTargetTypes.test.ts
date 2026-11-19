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

  test("treats generic parameters as bound inside their declaration only", () => {
    const sources = new Map([
      ["CommandError.swift", "enum CommandError: Error { case failed }\n"],
      [
        "Use.swift",
        [
          "struct Use<CommandError> { let e: CommandError }",
          "func echo<CommandError>(_ value: CommandError) -> CommandError { value }",
          "protocol P { func f<CommandError>(_ e: CommandError) -> CommandError }",
          "struct Other { let e: CommandError }",
          "",
        ].join("\n"),
      ],
    ]);
    const target = { name: "T", files: ["Use.swift"], packages: [] };
    expect(findMissingTypes([target], sources, new Map())).toEqual([
      {
        target: "T",
        file: "Use.swift",
        line: 4,
        type: "CommandError",
        definedIn: ["CommandError.swift"],
      },
    ]);
  });

  test("binds a nested type inside its declaring type and its extensions only", () => {
    const sources = new Map([
      ["Geometry.swift", "struct Geometry {}\n"],
      [
        "Use.swift",
        [
          "struct Own {",
          "  let first: Geometry",
          "  struct Geometry {}",
          "}",
          "extension Own { var g: Geometry { Geometry() } }",
          "struct Use { let geometry: Geometry }",
          "",
        ].join("\n"),
      ],
    ]);
    const target = { name: "T", files: ["Use.swift"], packages: [] };
    expect(findMissingTypes([target], sources, new Map())).toEqual([
      { target: "T", file: "Use.swift", line: 6, type: "Geometry", definedIn: ["Geometry.swift"] },
    ]);
  });

  test("resolves a module-qualified type against the package the target depends on", () => {
    const sources = withResponse("struct R { let e: Wire.WireEnvelope }\n");
    expect(findMissingTypes([TV], sources, PACKAGES)).toEqual([]);
    expect(findMissingTypes([{ ...TV, packages: [] }], sources, PACKAGES)).toEqual([
      {
        target: "CtrlProxyTVUITests",
        file: "Sources/CtrlProxy/Models/HierarchyUpdateResponse.swift",
        line: 2,
        type: "Wire.WireEnvelope",
        definedIn: ["Wire/Sources/Wire/Envelope.swift"],
      },
    ]);
  });

  test("binds an associatedtype inherited through an intermediate protocol (#18347)", () => {
    const sources = new Map([
      ["Geometry.swift", "struct Geometry {}\n"],
      [
        "Use.swift",
        [
          "protocol P { associatedtype Geometry }",
          "protocol Q: P {}",
          "protocol R: Q { func f() -> Geometry }",
          "struct Use { let g: Geometry }",
          "",
        ].join("\n"),
      ],
    ]);
    const target = { name: "T", files: ["Use.swift"], packages: [] };
    expect(findMissingTypes([target], sources, new Map())).toEqual([
      { target: "T", file: "Use.swift", line: 4, type: "Geometry", definedIn: ["Geometry.swift"] },
    ]);
  });

  test("binds the subjects of a where clause in its declaration only (#18347)", () => {
    const sources = new Map([
      ["Element.swift", "struct Element {}\n"],
      [
        "Use.swift",
        [
          "extension Array where Element: Equatable { func first() -> Element? { nil } }",
          "protocol P { func f<T>(_ t: T) -> Element where Element: Equatable }",
          "struct Use { let e: Element }",
          "",
        ].join("\n"),
      ],
    ]);
    const target = { name: "T", files: ["Use.swift"], packages: [] };
    expect(findMissingTypes([target], sources, new Map())).toEqual([
      { target: "T", file: "Use.swift", line: 3, type: "Element", definedIn: ["Element.swift"] },
    ]);
  });

  test("does not bind the concrete side of a same-type where requirement (#18382)", () => {
    const sources = new Map([
      ["Geometry.swift", "struct Geometry {}\n"],
      ["Element.swift", "struct Element {}\n"],
      [
        "Left.swift",
        "protocol P { associatedtype X }\nfunc f<T: P>(_ value: T) where Geometry == T.X {}\n",
      ],
      ["Right.swift", "func g<T: P>(_ value: T) where T.X == Geometry {}\n"],
      [
        "Extension.swift",
        "extension Array where Element == Int { func e() -> Element? { nil } }\n",
      ],
    ]);
    const target = {
      name: "T",
      files: ["Left.swift", "Right.swift", "Extension.swift"],
      packages: [],
    };
    expect(findMissingTypes([target], sources, new Map())).toEqual([
      { target: "T", file: "Left.swift", line: 2, type: "Geometry", definedIn: ["Geometry.swift"] },
      {
        target: "T",
        file: "Right.swift",
        line: 1,
        type: "Geometry",
        definedIn: ["Geometry.swift"],
      },
    ]);
  });

  test("binds a same-type subject inherited from an extended SDK type (#18525)", () => {
    const sources = new Map([
      ["Element.swift", "struct Element {}\n"],
      ["Geometry.swift", "struct Geometry {}\n"],
      [
        "Use.swift",
        [
          "protocol P { associatedtype X }",
          "extension Array { func f<T: P>(_ t: T) where Element == T.X {} }",
          "func g<T: P>(_ t: T) where Geometry == T.X {}",
          "",
        ].join("\n"),
      ],
    ]);
    const target = { name: "T", files: ["Use.swift"], packages: [] };
    expect(findMissingTypes([target], sources, new Map())).toEqual([
      { target: "T", file: "Use.swift", line: 3, type: "Geometry", definedIn: ["Geometry.swift"] },
    ]);
  });

  test("does not treat capitalized enum case names as types (#18347)", () => {
    const sources = new Map([
      ["Bar.swift", "struct Bar {}\nstruct Payload {}\n"],
      [
        "Use.swift",
        [
          "enum E {",
          "  case Bar, Baz = 2",
          "  indirect case Qux(Payload)",
          "  func f() { switch self { case .Bar: break; default: break } }",
          "}",
          "",
        ].join("\n"),
      ],
    ]);
    const target = { name: "T", files: ["Use.swift"], packages: [] };
    expect(findMissingTypes([target], sources, new Map())).toEqual([
      { target: "T", file: "Use.swift", line: 3, type: "Payload", definedIn: ["Bar.swift"] },
    ]);
  });

  test("binds nested types only from files the target compiles (#18347)", () => {
    const sources = new Map([
      ["Own.swift", "struct Own { let geometry: Geometry; let shape: Shape }\n"],
      ["Extra.swift", "extension Own { struct Geometry {}; struct Shape {} }\n"],
      ["Geometry.swift", "struct Geometry {}\n"],
    ]);
    const target = { name: "T", files: ["Own.swift"], packages: [] };
    expect(findMissingTypes([target], sources, new Map())).toEqual([
      {
        target: "T",
        file: "Own.swift",
        line: 1,
        type: "Geometry",
        definedIn: ["Geometry.swift", "Extra.swift"],
      },
      { target: "T", file: "Own.swift", line: 1, type: "Shape", definedIn: ["Extra.swift"] },
    ]);
    const withExtra = { ...target, files: ["Own.swift", "Extra.swift"] };
    expect(findMissingTypes([withExtra], sources, new Map())).toEqual([]);
  });

  test("throws when a target compiles a file with no source text (#18347)", () => {
    const target = { name: "T", files: ["../outside/Use.swift"], packages: [] };
    expect(() => findMissingTypes([target], SOURCES, PACKAGES)).toThrow(
      "no source text for target files: T: ../outside/Use.swift",
    );
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

  test("reads and checks target sources outside the project directory (#18347)", () => {
    const dir = join(root, "outside-project");
    write(
      "outside-project/project.yml",
      "targets:\n  TV:\n    sources:\n      - ../shared/Use.swift\n",
    );
    write("outside-project/Sources/Helper.swift", "struct Helper {}\n");
    write("shared/Use.swift", "struct Use { let h: Helper }\n");

    const { targets, sources, packageFiles } = loadProject(dir);
    expect(sources.get("../shared/Use.swift")).toBe("struct Use { let h: Helper }\n");
    expect(findMissingTypes(targets, sources, packageFiles)).toEqual([
      {
        target: "TV",
        file: "../shared/Use.swift",
        line: 1,
        type: "Helper",
        definedIn: ["Sources/Helper.swift"],
      },
    ]);
  });

  test("normalizes ./-prefixed file entries to the keys of the project traversal", () => {
    const dir = join(root, "dotted");
    write(
      "dotted/project.yml",
      "targets:\n  TV:\n    sources:\n      - ./Sources//Shared.swift\n      - path: ./Tests\n",
    );
    write("dotted/Sources/Shared.swift", "struct Shared { let h: Helper }\n");
    write("dotted/Sources/Helper.swift", "struct Helper {}\n");
    write("dotted/Tests/Case.swift", "struct Case { let s: Shared }\n");

    const { targets, sources, packageFiles } = loadProject(dir);
    expect(targets[0]?.files).toEqual(["Sources/Shared.swift", "Tests/Case.swift"]);
    expect(findMissingTypes(targets, sources, packageFiles).map((m) => m.file)).toEqual([
      "Sources/Shared.swift",
    ]);
  });
});
