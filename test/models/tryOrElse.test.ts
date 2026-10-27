import { describe, expect, test } from "bun:test";
import { tryOrElse, tryOrElseAsync } from "../../src/models/tryOrElse";

describe("tryOrElse", () => {
  test("returns the attempt result when it succeeds", () => {
    expect(
      tryOrElse(
        () => 1,
        () => 2,
      ),
    ).toBe(1);
  });

  test("forwards the thrown value to recover", () => {
    const boom = new Error("boom");
    expect(
      tryOrElse(
        () => {
          throw boom;
        },
        (error) => (error === boom ? "recovered" : "wrong"),
      ),
    ).toBe("recovered");
  });

  test("async variant recovers from a rejection", async () => {
    expect(
      await tryOrElseAsync(
        async () => {
          throw new Error("nope");
        },
        () => "fallback",
      ),
    ).toBe("fallback");
  });
});
