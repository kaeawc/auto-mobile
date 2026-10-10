import { describe, expect, test } from "bun:test";
import { PrototypeCommitGenerations } from "../../../src/features/prototype/PrototypeCommitGenerations";

describe("PrototypeCommitGenerations", () => {
  test("only the newest show of an id on a device is latest", () => {
    const generations = new PrototypeCommitGenerations();
    const older = generations.begin("dev", "panel");
    const newer = generations.begin("dev", "panel");
    expect(generations.isLatest("dev", "panel", older)).toBe(false);
    expect(generations.isLatest("dev", "panel", newer)).toBe(true);
  });

  test("generations are independent per device and per id", () => {
    const generations = new PrototypeCommitGenerations();
    const first = generations.begin("dev", "panel");
    generations.begin("other", "panel");
    generations.begin("dev", "second");
    expect(generations.isLatest("dev", "panel", first)).toBe(true);
  });

  test("a withdrawn newer show hands latest back to the older one", () => {
    const generations = new PrototypeCommitGenerations();
    const older = generations.begin("dev", "panel");
    const refused = generations.begin("dev", "panel");
    generations.withdraw("dev", "panel", refused);
    expect(generations.isLatest("dev", "panel", older)).toBe(true);
    // Withdrawn but still the newest arrival: it may commit its own refusal.
    expect(generations.isLatest("dev", "panel", refused)).toBe(true);
  });

  test("withdrawing out of order still leaves the newest remaining show latest", () => {
    const generations = new PrototypeCommitGenerations();
    const first = generations.begin("dev", "panel");
    const second = generations.begin("dev", "panel");
    const third = generations.begin("dev", "panel");
    generations.withdraw("dev", "panel", second);
    expect(generations.isLatest("dev", "panel", third)).toBe(true);
    generations.withdraw("dev", "panel", third);
    expect(generations.isLatest("dev", "panel", first)).toBe(true);
  });

  test("withdrawing an older show does not displace a newer latest", () => {
    const generations = new PrototypeCommitGenerations();
    const older = generations.begin("dev", "panel");
    const newer = generations.begin("dev", "panel");
    generations.withdraw("dev", "panel", older);
    expect(generations.isLatest("dev", "panel", newer)).toBe(true);
  });

  test("a withdrawn show still defers to any newer show and commits only while newest", () => {
    const generations = new PrototypeCommitGenerations();
    const refused = generations.begin("dev", "panel");
    generations.withdraw("dev", "panel", refused);
    expect(generations.isLatest("dev", "panel", refused)).toBe(true);
    generations.begin("dev", "panel");
    expect(generations.isLatest("dev", "panel", refused)).toBe(false);
  });

  test("withdraw is idempotent", () => {
    const generations = new PrototypeCommitGenerations();
    const older = generations.begin("dev", "panel");
    const refused = generations.begin("dev", "panel");
    generations.withdraw("dev", "panel", refused);
    generations.withdraw("dev", "panel", refused);
    generations.withdraw("dev", "panel", 99);
    expect(generations.isLatest("dev", "panel", older)).toBe(true);
  });

  test("a settled newer show keeps older ones superseded even if a later one is withdrawn", () => {
    const generations = new PrototypeCommitGenerations();
    const older = generations.begin("dev", "panel");
    const settled = generations.begin("dev", "panel");
    const refused = generations.begin("dev", "panel");
    generations.settle("dev", "panel", settled);
    generations.withdraw("dev", "panel", refused);
    expect(generations.isLatest("dev", "panel", older)).toBe(false);
  });

  test("bookkeeping is dropped once every show for an id has settled", () => {
    const generations = new PrototypeCommitGenerations();
    const a = generations.begin("dev", "panel");
    const b = generations.begin("dev", "panel");
    generations.begin("dev", "other");
    expect(generations.trackedIds()).toBe(2);
    generations.withdraw("dev", "panel", b);
    generations.settle("dev", "panel", b);
    generations.settle("dev", "panel", b);
    expect(generations.trackedIds()).toBe(2);
    generations.settle("dev", "panel", a);
    expect(generations.trackedIds()).toBe(1);
    generations.settle("dev", "other", 1);
    expect(generations.trackedIds()).toBe(0);
  });
});
