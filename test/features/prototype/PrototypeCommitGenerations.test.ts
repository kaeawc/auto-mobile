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
    expect(generations.isLatest("dev", "panel", refused)).toBe(false);
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
});
