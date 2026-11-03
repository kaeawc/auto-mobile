import { describe, expect, test } from "bun:test";
import { PrototypeShownSpecs } from "../../../src/features/prototype/PrototypeShownSpecs";
import {
  PrototypeSpecRevisions,
  type PrototypeSpecRevisionEvent,
} from "../../../src/features/prototype/prototypeSpecRevisions";
import { FakeTimer } from "../../fakes/FakeTimer";

const spec = (text: string) => ({ id: "checkout", root: { type: "text", text } });

function show(
  specs: PrototypeShownSpecs,
  id: string,
  options: {
    text?: string;
    platform?: "android" | "ios";
    variant?: { group: string; label: string };
  } = {},
) {
  const ticket = specs.beginShow("d", id, true, options.platform ?? "android");
  specs.endShow("d", ticket, { id, spec: spec(options.text ?? id), variant: options.variant });
}

function patch(specs: PrototypeShownSpecs, id: string, text: string, deviceRevision?: number) {
  const read = specs.read("d", id);
  if (read.kind !== "known") {
    throw new Error("expected a known spec");
  }
  return specs.commitPatch("d", id, read.version, { spec: spec(text), deviceRevision });
}

describe("PrototypeSpecRevisions", () => {
  test("numbers show, same-id show and landed patch 1, 2, 3 with time, platform and device revision", () => {
    const timer = new FakeTimer();
    const revisions = new PrototypeSpecRevisions(timer);
    const specs = new PrototypeShownSpecs(revisions);
    timer.setCurrentTime(1_000);
    show(specs, "checkout", { platform: "ios", variant: { group: "g", label: "A" } });
    timer.setCurrentTime(2_000);
    show(specs, "checkout", {
      text: "again",
      platform: "ios",
      variant: { group: "g", label: "A" },
    });
    timer.setCurrentTime(3_000);
    expect(patch(specs, "checkout", "patched", 17)).toBe(true);

    const history = revisions.history("checkout");
    expect(history.map((entry) => [entry.revision, entry.operation, entry.time])).toEqual([
      [1, "show", 1_000],
      [2, "show", 2_000],
      [3, "patch", 3_000],
    ]);
    expect(history[2]).toMatchObject({
      deviceRevision: 17,
      platform: "ios",
      variant: { group: "g", label: "A" },
      spec: spec("patched"),
    });
    expect(revisions.revision("checkout").revision).toBe(3);
    expect(revisions.revision("checkout", 1).spec).toEqual(spec("checkout"));
  });

  test("device data writes, refused and superseded shows add no revision", () => {
    const revisions = new PrototypeSpecRevisions(new FakeTimer());
    const specs = new PrototypeShownSpecs(revisions);
    show(specs, "checkout");
    specs.recordDeviceDataWrite("d", "checkout", {
      op: "set",
      path: "/data/count",
      value: 2,
      revision: 5,
    });
    const refused = specs.beginShow("d", "checkout");
    specs.endShow("d", refused, undefined, "typed");
    const older = specs.beginShow("d", "checkout");
    specs.beginShow("d", "checkout");
    specs.endShow("d", older, { id: "checkout", spec: spec("late") });
    expect(revisions.history("checkout").map((entry) => entry.revision)).toEqual([1]);
  });

  test("a show without a variant leaves the group; a patch keeps the last one", () => {
    const revisions = new PrototypeSpecRevisions(new FakeTimer());
    const specs = new PrototypeShownSpecs(revisions);
    show(specs, "checkout", { variant: { group: "g", label: "A" } });
    patch(specs, "checkout", "patched");
    expect(revisions.revision("checkout").variant).toEqual({ group: "g", label: "A" });
    show(specs, "checkout");
    expect(revisions.revision("checkout").variant).toBeUndefined();
  });

  test("keeps the last 20 revisions; an evicted one names the oldest kept", () => {
    const revisions = new PrototypeSpecRevisions(new FakeTimer());
    for (let index = 0; index < 23; index++) {
      revisions.recordShow("checkout", { spec: spec(`r${index + 1}`) });
    }
    expect(revisions.history("checkout").map((entry) => entry.revision)[0]).toBe(4);
    expect(() => revisions.revision("checkout", 2)).toThrow(
      'Revision 2 of prototype "checkout" was evicted; the oldest kept revision is 4.',
    );
    expect(() => revisions.revision("checkout", 99)).toThrow(
      'Prototype "checkout" has no revision 99. Kept revisions: 4, 5,',
    );
  });

  test("an unknown id lists the known ones", () => {
    const revisions = new PrototypeSpecRevisions(new FakeTimer());
    expect(() => revisions.history("nope")).toThrow("Known prototypes: none.");
    revisions.recordShow("b", { spec: spec("b") });
    revisions.recordShow("a", { spec: spec("a") });
    expect(() => revisions.revision("nope")).toThrow('Unknown prototype "nope"');
    expect(() => revisions.revision("nope")).toThrow("Known prototypes: b, a.");
  });

  test("the byte cap drops older revisions first, then the least recently revised id", () => {
    const one = Buffer.byteLength(JSON.stringify(spec("r1")));
    const revisions = new PrototypeSpecRevisions(new FakeTimer(), {
      revisions: 20,
      bytes: one * 3,
    });
    const events: PrototypeSpecRevisionEvent[] = [];
    revisions.onRevision((event) => events.push(event));
    revisions.recordShow("a", { spec: spec("r1") });
    revisions.recordShow("a", { spec: spec("r2") });
    revisions.recordShow("b", { spec: spec("r1") });
    revisions.recordShow("c", { spec: spec("r1") });
    // Over the cap: a's r1 goes before any id's latest, and a hears that its history changed.
    expect(revisions.history("a").map((entry) => entry.revision)).toEqual([2]);
    expect(events.slice(-2)).toEqual([
      { kind: "revision", id: "c", revision: 1 },
      { kind: "pruned", id: "a" },
    ]);
    revisions.recordShow("d", { spec: spec("r1") });
    // Only latest revisions remain, so the least recently revised id (a) is dropped whole.
    expect(revisions.ids()).toEqual(["b", "c", "d"]);
    expect(events.at(-1)).toEqual({ kind: "evicted", id: "a" });
    // A later show continues a's numbering instead of reusing revision 1.
    revisions.recordShow("a", { spec: spec("r3") });
    expect(revisions.revision("a").revision).toBe(3);
  });

  test("listeners hear each revision and can unsubscribe", () => {
    const revisions = new PrototypeSpecRevisions(new FakeTimer());
    const events: PrototypeSpecRevisionEvent[] = [];
    const stop = revisions.onRevision((event) => events.push(event));
    revisions.recordShow("a", { spec: spec("a") });
    revisions.recordPatch("a", { spec: spec("b") });
    stop();
    revisions.recordPatch("a", { spec: spec("c") });
    expect(events).toEqual([
      { kind: "revision", id: "a", revision: 1 },
      { kind: "revision", id: "a", revision: 2 },
    ]);
  });
});
