import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PrototypeSpecRevisions } from "../../../../src/features/prototype/prototypeSpecRevisions";
import { readPrototypeWebResource } from "../../../../src/features/prototype/web/prototypeWebResource";
import { FakeTimer } from "../../../fakes/FakeTimer";

const spec = (id: string, text: string) => ({
  id,
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text },
});

function revisions() {
  const store = new PrototypeSpecRevisions(new FakeTimer());
  store.recordShow("checkout", { spec: spec("checkout", "first"), platform: "android" });
  store.recordPatch("checkout", { spec: spec("checkout", "second"), deviceRevision: 7 });
  return store;
}

describe("readPrototypeWebResource", () => {
  test("reads the latest revision by default, with _meta", () => {
    const web = readPrototypeWebResource(revisions(), { id: "checkout" }, "1.2.3");
    expect(web.html).toContain('data-revision="2"');
    expect(web.meta).toEqual({
      revision: 2,
      deviceRevision: 7,
      revisions: [1, 2],
      variants: ["checkout"],
      frame: "pixel-9",
      sha256: createHash("sha256").update(web.html).digest("hex"),
      rendererVersion: "1.2.3",
    });
  });

  test("reads revision=N", () => {
    const web = readPrototypeWebResource(revisions(), { id: "checkout", revision: "1" }, "v");
    expect(web.meta.revision).toBe(1);
    expect(web.meta.deviceRevision).toBeUndefined();
    expect(web.html).toContain(
      '<body data-variant="checkout" data-revision="1" data-platform="android" data-orientation="portrait">',
    );
  });

  test("the default frame follows the platform that showed the revision", () => {
    const store = new PrototypeSpecRevisions(new FakeTimer());
    store.recordShow("checkout", { spec: spec("checkout", "x"), platform: "ios" });
    expect(readPrototypeWebResource(store, { id: "checkout" }, "v").meta.frame).toBe("iphone-16");
    expect(
      readPrototypeWebResource(store, { id: "checkout", frame: "pixel-9" }, "v").meta.frame,
    ).toBe("pixel-9");
  });

  test.each([
    [{ id: "nope" }, 'Unknown prototype "nope"'],
    [{ id: "checkout", frame: "nokia-3310" }, 'Unknown device frame "nokia-3310". Valid frames:'],
    [
      { id: "checkout", variant: "other" },
      'Unknown variant "other" for prototype "checkout". Variants: checkout.',
    ],
    [{ id: "checkout", revision: "9" }, "Kept revisions: 1, 2"],
    [{ id: "checkout", revision: "two" }, 'Invalid prototype revision "two"'],
  ])("%p is an actionable error", (query, message) => {
    expect(() => readPrototypeWebResource(revisions(), query, "v")).toThrow(message);
  });

  test("ids sharing a variant group are variants of one page", () => {
    const store = new PrototypeSpecRevisions(new FakeTimer());
    const variant = (label: string) => ({ group: "checkout-ideas", label });
    store.recordShow("compact", { spec: spec("compact", "c"), variant: variant("Compact") });
    store.recordShow("other", { spec: spec("other", "o") });
    store.recordShow("roomy", { spec: spec("roomy", "r"), variant: variant("Roomy") });
    const web = readPrototypeWebResource(store, { id: "roomy" }, "v");
    expect(web.meta.variants).toEqual(["compact", "roomy"]);
    expect(web.html).toContain('<body data-variant="roomy"');
    expect(web.html).toContain(">Compact</option>");
    expect(web.html).toContain(">Roomy</option>");
    const first = readPrototypeWebResource(store, { id: "roomy", variant: "compact" }, "v");
    expect(first.html).toContain('<body data-variant="compact"');
  });

  test("the same input yields the same bytes and sha256", () => {
    const a = readPrototypeWebResource(revisions(), { id: "checkout" }, "v");
    const b = readPrototypeWebResource(revisions(), { id: "checkout" }, "v");
    expect(a.html).toBe(b.html);
    expect(a.meta.sha256).toBe(b.meta.sha256);
  });
});
