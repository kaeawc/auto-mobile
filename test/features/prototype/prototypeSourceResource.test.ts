import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PrototypeSpecRevisions } from "../../../src/features/prototype/prototypeSpecRevisions";
import {
  readPrototypeSourceResource,
  type PrototypeSourceFormat,
} from "../../../src/features/prototype/prototypeSourceResource";
import { FakeTimer } from "../../fakes/FakeTimer";

const spec = (text: string) => ({
  id: "checkout",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text },
});

const withAssets = {
  id: "checkout",
  window: { placement: { type: "fullscreen" } },
  root: {
    type: "column",
    style: { fontFamily: { asset: "brand" } },
    children: [
      { type: "image", asset: "hero" },
      { type: "text", text: 'Pay $5 "now" \\ é 🙂' },
    ],
  },
};

function store(platform: "android" | "ios" = "android") {
  const revisions = new PrototypeSpecRevisions(new FakeTimer());
  revisions.recordShow("checkout", { spec: spec("first"), platform });
  revisions.recordPatch("checkout", { spec: spec("second"), deviceRevision: 7 });
  return revisions;
}

function storeOf(value: Record<string, unknown>) {
  const revisions = new PrototypeSpecRevisions(new FakeTimer());
  revisions.recordShow("checkout", { spec: value, platform: "android" });
  return revisions;
}

/** The inlined spec literal, decoded back to the string it stands for. */
function inlinedSpec(format: PrototypeSourceFormat, text: string): unknown {
  const pattern =
    format === "compose"
      ? /private const val SPEC = (".*")\n/
      : /static let spec = Data\((".*")\.utf8\)/;
  const literal = pattern.exec(text)?.[1];
  if (literal === undefined) {
    throw new Error("no inlined spec literal");
  }
  const json =
    format === "compose"
      ? literal.replaceAll("\\$", "$")
      : literal.replace(/\\u\{([0-9a-f]+)\}/g, (_, hex: string) =>
          JSON.stringify(String.fromCodePoint(Number.parseInt(hex, 16))).slice(1, -1),
        );
  return JSON.parse(JSON.parse(json));
}

describe.each(["compose", "swiftui"] as const)("readPrototypeSourceResource(%s)", (format) => {
  const mimeType = format === "compose" ? "text/x-kotlin" : "text/x-swift";
  const defaultFrame = format === "compose" ? "pixel-9" : "iphone-16";

  test("reads the latest revision by default, with _meta", () => {
    const file = readPrototypeSourceResource(store(), format, { id: "checkout" }, "1.2.3");
    expect(file.mimeType).toBe(mimeType);
    expect(inlinedSpec(format, file.text)).toEqual(spec("second"));
    expect(file.meta).toEqual({
      revision: 2,
      deviceRevision: 7,
      revisions: [1, 2],
      frame: defaultFrame,
      sha256: createHash("sha256").update(file.text).digest("hex"),
      rendererVersion: "1.2.3",
    });
  });

  test("reads revision=N", () => {
    const file = readPrototypeSourceResource(
      store(),
      format,
      { id: "checkout", revision: "1" },
      "v",
    );
    expect(file.meta.revision).toBe(1);
    expect(file.meta.deviceRevision).toBeUndefined();
    expect(inlinedSpec(format, file.text)).toEqual(spec("first"));
  });

  test("the default frame is the format's platform default whatever platform showed it", () => {
    for (const platform of ["android", "ios"] as const) {
      const file = readPrototypeSourceResource(
        store(platform),
        format,
        // Revision 1 is the show, which records the showing platform.
        { id: "checkout", revision: "1" },
        "v",
      );
      expect(file.meta.frame).toBe(defaultFrame);
    }
  });

  test("the preview is sized from frame", () => {
    const file = readPrototypeSourceResource(
      store(),
      format,
      { id: "checkout", frame: "small-phone" },
      "v",
    );
    expect(file.meta.frame).toBe("small-phone");
    expect(file.text).toContain(
      format === "compose"
        ? '@Preview(name = "Small Android phone", widthDp = 360, heightDp = 640)'
        : ".frame(width: 360, height: 640)",
    );
  });

  test("a TV or car preview is sized in landscape, its only orientation (#16446)", () => {
    const file = readPrototypeSourceResource(
      store(),
      format,
      { id: "checkout", frame: "android-tv-1080p" },
      "v",
    );
    expect(file.text).toContain(
      format === "compose"
        ? '@Preview(name = "Android TV (1080p)", widthDp = 960, heightDp = 540)'
        : ".frame(width: 960, height: 540)",
    );
  });

  test.each([
    [{ id: "nope" }, 'Unknown prototype "nope"'],
    [{ id: "checkout", frame: "nokia-3310" }, 'Unknown device frame "nokia-3310". Valid frames:'],
    [{ id: "checkout", revision: "9" }, "Kept revisions: 1, 2"],
    [{ id: "checkout", revision: "two" }, 'Invalid prototype revision "two"'],
  ])("%p is an actionable error", (query, message) => {
    expect(() => readPrototypeSourceResource(store(), format, query, "v")).toThrow(message);
  });

  test("the same input yields the same bytes and sha256", () => {
    const a = readPrototypeSourceResource(store(), format, { id: "checkout" }, "v");
    const b = readPrototypeSourceResource(store(), format, { id: "checkout" }, "v");
    expect(b.text).toBe(a.text);
    expect(b.meta.sha256).toBe(a.meta.sha256);
  });

  test("assets are referenced by id and listed with their URIs in the header", () => {
    const file = readPrototypeSourceResource(storeOf(withAssets), format, { id: "checkout" }, "v");
    expect(file.text).toContain("automobile:prototype/native/asset?id=checkout&assetId=brand");
    expect(file.text).toContain("automobile:prototype/native/asset?id=checkout&assetId=hero");
    expect(file.text).toContain(format === "compose" ? '"hero" to it' : '"hero": resource("hero")');
    expect(inlinedSpec(format, file.text)).toEqual(withAssets);
  });

  test("the output file", () => {
    const file = readPrototypeSourceResource(
      storeOf(withAssets),
      format,
      { id: "checkout" },
      "1.2.3",
    );
    expect(file.text).toMatchSnapshot();
  });
});

describe("Compose spec constant", () => {
  test("a spec too long for one JVM string constant is split into joined literals", () => {
    const long = spec("x".repeat(40_000));
    const file = readPrototypeSourceResource(storeOf(long), "compose", { id: "checkout" }, "v");
    expect(file.text).not.toContain("private const val SPEC");
    const literals =
      /private val SPEC =\n {2}listOf\(\n((?: {6}".*",\n)+) {4}\)\n {4}\.joinToString\(""\)/.exec(
        file.text,
      )?.[1];
    expect(literals).toBeDefined();
    const chunks = (literals ?? "")
      .trimEnd()
      .split(",\n")
      .map((line) => line.trim().replace(/,$/, ""));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 16_386)).toBe(true);
    expect(JSON.parse(chunks.map((chunk) => JSON.parse(chunk) as string).join(""))).toEqual(long);
  });
});

describe("SwiftUI export", () => {
  test("refuses a custom shader like the native resource", () => {
    const shaded = {
      ...spec("x"),
      root: { type: "box", style: { shader: { asset: "s" } } },
    };
    expect(() =>
      readPrototypeSourceResource(storeOf(shaded), "swiftui", { id: "checkout" }, "v"),
    ).toThrow("Custom AGSL shaders are Android only");
  });
});
