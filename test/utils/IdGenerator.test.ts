import { describe, expect, test } from "bun:test";
import { CountingIdGenerator, NodeIdGenerator } from "../../src/utils/IdGenerator";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";

describe("NodeIdGenerator", function() {
  test("produces unique UUID-shaped ids", function() {
    const generator = new NodeIdGenerator();
    const first = generator.next();
    const second = generator.next();

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(first).not.toBe(second);
  });
});

describe("CountingIdGenerator", function() {
  test("produces incrementing ids with the configured prefix", function() {
    const generator = new CountingIdGenerator("req");

    expect(generator.next()).toBe("req-1");
    expect(generator.next()).toBe("req-2");
  });

  test("reset restarts the counter", function() {
    const generator = new CountingIdGenerator("id");

    generator.next();
    generator.reset();

    expect(generator.next()).toBe("id-1");
  });
});

describe("FakeIdGenerator", function() {
  test("returns scripted ids before counter fallback", function() {
    const generator = new FakeIdGenerator(["a", "b"]);

    expect(generator.next()).toBe("a");
    expect(generator.next()).toBe("b");
    expect(generator.next()).toBe("fake-1");
  });

  test("setScripted replaces queued ids and resets the fallback counter", function() {
    const generator = new FakeIdGenerator();

    generator.next();
    generator.setScripted(["x"]);

    expect(generator.next()).toBe("x");
    expect(generator.next()).toBe("fake-1");
  });
});
