import { describe, expect, test } from "bun:test";
import {
  PROTOVIEWER_IMPORT_LINK_PREFIX,
  protoViewerImportLink,
  protoViewerShareUrlProblem,
} from "../../../../src/features/prototype/protoViewer/protoViewerShareLink";

const SHA = "a".repeat(64);

describe("ProtoViewer share URL", () => {
  test("accepts a plain https URL, query included", () => {
    expect(protoViewerShareUrlProblem("https://example.com/demo.automobile-proto")).toBeUndefined();
    expect(protoViewerShareUrlProblem("https://cdn.example.com/a/b?sig=1")).toBeUndefined();
  });

  test.each([
    ["http://example.com/demo", "https"],
    ["file:///tmp/demo", "https"],
    ["automobile-proto://import", "https"],
    ["example.com/demo", "absolute https"],
    ["https://user:pass@example.com/demo", "credentials"],
    ["https://token@example.com/demo", "credentials"],
    ["https://example.com/demo#x", "fragment"],
  ])("refuses %s", (url, reason) => {
    expect(protoViewerShareUrlProblem(url)).toContain(reason);
  });
});

describe("ProtoViewer import link", () => {
  test("percent-encodes the url and carries the hash", () => {
    const link = protoViewerImportLink("https://example.com/a b?x=1&y=2", SHA);
    expect(link.startsWith(`${PROTOVIEWER_IMPORT_LINK_PREFIX}?url=`)).toBe(true);
    const query = new URL(link).searchParams;
    expect(query.get("url")).toBe("https://example.com/a b?x=1&y=2");
    expect(query.get("sha256")).toBe(SHA);
    expect([...query.keys()]).toEqual(["url", "sha256"]);
  });

  test("refuses a hash that is not 64 lowercase hex characters", () => {
    expect(() => protoViewerImportLink("https://example.com", "A".repeat(64))).toThrow();
    expect(() => protoViewerImportLink("https://example.com", "a".repeat(63))).toThrow();
  });
});
