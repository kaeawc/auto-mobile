import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compileAjv2020 } from "../../../helpers/jsonSchemaCompile";
import {
  screenshotOptionsSchema,
  validateScreenshotOptions,
} from "../../../../src/features/observe/screenshot/screenshotOptions";
import { observeSchema } from "../../../../src/server/observeTools";

describe("screenshot encoding options", () => {
  let advertised: (value: unknown) => boolean;
  beforeAll(() => {
    const definitions = JSON.parse(readFileSync("schemas/tool-definitions.json", "utf8")) as Array<{
      name: string;
      inputSchema: object;
    }>;
    const observe = definitions.find((definition) => definition.name === "observe");
    if (!observe) {
      throw new Error("observe tool definition is missing");
    }
    advertised = compileAjv2020(observe.inputSchema);
  });
  const cases: Array<[object, boolean]> = [
    [{}, true],
    [{ format: "png" }, true],
    [{ format: "jpeg" }, true],
    [{ format: "jpeg", quality: 1 }, true],
    [{ format: "jpeg", quality: 100 }, true],
    [{ format: "webp", quality: 80 }, true],
    [{ format: "webp", lossless: true }, true],
    [{ format: "webp", lossless: false, quality: 80 }, true],
    [{ format: "png", quality: 80 }, false],
    [{ format: "png", lossless: true }, false],
    [{ format: "jpeg", lossless: false }, false],
    [{ format: "webp", quality: 80, lossless: true }, false],
    [{ format: "jpeg", quality: 0 }, false],
    [{ format: "jpeg", quality: 101 }, false],
    [{ format: "webp", quality: 1.5 }, false],
    [{ format: "gif" }, false],
  ];

  for (const [options, accepted] of cases) {
    test(`${JSON.stringify(options)} is ${accepted ? "accepted" : "rejected"} at both boundaries`, () => {
      expect(screenshotOptionsSchema.safeParse(options).success).toBe(accepted);
      expect(
        observeSchema.safeParse({ screenshot: "settled", screenshotOptions: options }).success,
      ).toBe(accepted);
      expect(advertised({ screenshot: "settled", screenshotOptions: options })).toBe(accepted);
      if (accepted) {
        expect(() => validateScreenshotOptions(options)).not.toThrow();
      } else {
        expect(() => validateScreenshotOptions(options)).toThrow("Invalid screenshot options");
      }
    });
  }

  test("options require a settled capture", () => {
    expect(observeSchema.safeParse({ screenshotOptions: {} }).success).toBe(false);
    expect(observeSchema.safeParse({ screenshot: "async", screenshotOptions: {} }).success).toBe(
      false,
    );
  });
});
