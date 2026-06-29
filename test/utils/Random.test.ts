import { describe, expect, test } from "bun:test";
import { CryptoRandom, SeededRandom } from "../../src/utils/Random";

describe("CryptoRandom", function() {
  test("uuid returns a v4 UUID", function() {
    expect(new CryptoRandom().uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("SeededRandom", function() {
  test("same seeds produce the same sequence", function() {
    const first = new SeededRandom(42);
    const second = new SeededRandom(42);

    expect(Array.from({ length: 10 }, () => first.next())).toEqual(
      Array.from({ length: 10 }, () => second.next())
    );
  });

  test("reseed restarts the sequence", function() {
    const random = new SeededRandom(7);
    const first = random.next();

    random.next();
    random.reseed(7);

    expect(random.next()).toBe(first);
  });

  test("uuid is deterministic and v4-shaped", function() {
    const first = new SeededRandom(100).uuid();
    const second = new SeededRandom(100).uuid();

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
