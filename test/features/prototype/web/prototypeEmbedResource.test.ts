import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { requiredPrototypeCapabilities } from "../../../../src/features/prototype/prototypeCapabilityGates";
import { PrototypeSpecRevisions } from "../../../../src/features/prototype/prototypeSpecRevisions";
import { readPrototypeEmbedResource } from "../../../../src/features/prototype/web/prototypeEmbedResource";
import { FakeTimer } from "../../../fakes/FakeTimer";

const spec = (id: string, text: string, deadTaps = false) => ({
  id,
  window: { placement: { type: "fullscreen" }, ...(deadTaps ? { deadTaps: true } : {}) },
  root: { type: "text", text },
});

function revisions() {
  const store = new PrototypeSpecRevisions(new FakeTimer());
  store.recordShow("checkout", { spec: spec("checkout", "first"), platform: "android" });
  store.recordPatch("checkout", { spec: spec("checkout", "second", true), deviceRevision: 7 });
  return store;
}

describe("readPrototypeEmbedResource", () => {
  test("serves the latest revision as an envelope whose requires is the host's gate result", () => {
    const embed = readPrototypeEmbedResource(revisions(), { id: "checkout" }, "1.2.3");
    const latest = spec("checkout", "second", true);
    expect(JSON.parse(embed.text)).toEqual({
      format: "automobile-prototype-embed",
      version: 1,
      requires: requiredPrototypeCapabilities(latest),
      spec: latest,
    });
    expect(embed.envelope.requires).toContain("prototype_dead_tap_v1");
    expect(embed.meta).toEqual({
      revision: 2,
      deviceRevision: 7,
      revisions: [1, 2],
      variants: ["checkout"],
      sha256: createHash("sha256").update(embed.text).digest("hex"),
      rendererVersion: "1.2.3",
    });
    expect(embed.meta).not.toHaveProperty("frame");
  });

  test("reads revision=N with that revision's requires", () => {
    const embed = readPrototypeEmbedResource(revisions(), { id: "checkout", revision: "1" }, "v");
    expect(embed.meta.revision).toBe(1);
    expect(embed.meta.deviceRevision).toBeUndefined();
    expect(embed.envelope.spec).toEqual(spec("checkout", "first"));
    expect(embed.envelope.requires).not.toContain("prototype_dead_tap_v1");
  });

  test.each([
    [{ id: "nope" }, 'Unknown prototype "nope"'],
    [
      { id: "checkout", variant: "other" },
      'Unknown variant "other" for prototype "checkout". Variants: checkout.',
    ],
    [{ id: "checkout", revision: "9" }, "Kept revisions: 1, 2"],
    [{ id: "checkout", revision: "two" }, 'Invalid prototype revision "two"'],
  ])("%p is an actionable error", (query, message) => {
    expect(() => readPrototypeEmbedResource(revisions(), query, "v")).toThrow(message);
  });

  test("variant picks which member of the group is served", () => {
    const store = new PrototypeSpecRevisions(new FakeTimer());
    const variant = (label: string) => ({ group: "checkout-ideas", label });
    store.recordShow("compact", { spec: spec("compact", "c"), variant: variant("Compact") });
    store.recordShow("roomy", { spec: spec("roomy", "r"), variant: variant("Roomy") });
    const own = readPrototypeEmbedResource(store, { id: "roomy" }, "v");
    expect(own.meta.variants).toEqual(["compact", "roomy"]);
    expect(own.envelope.spec).toEqual(spec("roomy", "r"));
    const other = readPrototypeEmbedResource(store, { id: "roomy", variant: "compact" }, "v");
    expect(other.envelope.spec).toEqual(spec("compact", "c"));
  });

  test("the same input yields the same bytes and sha256", () => {
    const a = readPrototypeEmbedResource(revisions(), { id: "checkout" }, "v");
    const b = readPrototypeEmbedResource(revisions(), { id: "checkout" }, "v");
    expect(a.text).toBe(b.text);
    expect(a.meta.sha256).toBe(b.meta.sha256);
  });
});
