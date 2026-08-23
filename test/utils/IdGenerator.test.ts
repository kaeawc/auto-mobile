import { describe, expect, test } from "bun:test";
import {
  CountingIdGenerator,
  createTimestampedId,
  NodeIdGenerator,
} from "../../src/utils/IdGenerator";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";

describe("NodeIdGenerator", function () {
  test("produces unique UUID-shaped ids", function () {
    const generator = new NodeIdGenerator();
    const first = generator.next();
    const second = generator.next();

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(first).not.toBe(second);
  });
});

describe("CountingIdGenerator", function () {
  test("produces incrementing ids with the configured prefix", function () {
    const generator = new CountingIdGenerator("req");

    expect(generator.next()).toBe("req-1");
    expect(generator.next()).toBe("req-2");
  });

  test("reset restarts the counter", function () {
    const generator = new CountingIdGenerator("id");

    generator.next();
    generator.reset();

    expect(generator.next()).toBe("id-1");
  });
});

describe("FakeIdGenerator", function () {
  test("returns scripted ids before counter fallback", function () {
    const generator = new FakeIdGenerator(["a", "b"]);

    expect(generator.next()).toBe("a");
    expect(generator.next()).toBe("b");
    expect(generator.next()).toBe("fake-1");
  });

  test("does not re-issue an already-emitted auto id after setScripted swaps the script", function () {
    const generator = new FakeIdGenerator();

    const firstAuto = generator.next();
    generator.setScripted(["x"]);

    expect(generator.next()).toBe("x");
    // Once the new script drains, the fallback must continue past the id it
    // already emitted rather than restart at fake-1 and collide with it.
    const secondAuto = generator.next();
    expect(secondAuto).not.toBe(firstAuto);
    expect(secondAuto).toBe("fake-2");
  });
});

describe("createTimestampedId", function () {
  test("keeps an observable timestamp while injecting deterministic uniqueness", function () {
    const timer = { now: () => 1234 };
    const ids = new CountingIdGenerator("test");

    expect(createTimestampedId("highlight", timer, ids)).toBe("highlight_1234_test-1");
    expect(createTimestampedId("highlight", timer, ids)).toBe("highlight_1234_test-2");
  });
});
