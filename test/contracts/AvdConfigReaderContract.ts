import { describe, expect, test } from "bun:test";
import {
  parseAvdConfig,
  type AvdConfigReader,
} from "../../src/utils/android-cmdline-tools/AvdConfigReader";

export interface AvdConfigReaderHandle {
  reader: AvdConfigReader;
  dispose?: () => Promise<void> | void;
}

/**
 * What every provisioned AVD in the contract reads back as. No captured config.ini fixture exists
 * in the repository, so the scenarios use an AVD whose config.ini is empty and the expectation is
 * the parser's own output for that content; hand-written device keys would be invented data.
 */
export const EMPTY_AVD_CONFIG = parseAvdConfig("");

/**
 * Shared behavioural contract for {@link AvdConfigReader} (#11868). `make` provisions an AVD for
 * each name; the fake and the file-backed reader must agree on which names resolve, that an
 * unknown AVD reads as null, and that callers cannot mutate each other's results.
 */
export function runAvdConfigReaderContract(
  name: string,
  make: (avdNames: string[]) => Promise<AvdConfigReaderHandle>,
): void {
  const withReader = async (
    avdNames: string[],
    body: (reader: AvdConfigReader) => Promise<void>,
  ): Promise<void> => {
    const handle = await make(avdNames);
    try {
      await body(handle.reader);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`AvdConfigReader contract: ${name}`, () => {
    test("a provisioned AVD reads back its parsed config", () =>
      withReader(["Pixel_9"], async (reader) => {
        expect(await reader.readConfig("Pixel_9")).toEqual(EMPTY_AVD_CONFIG);
      }));

    test("an AVD that was never provisioned reads as null", () =>
      withReader(["Pixel_9"], async (reader) => {
        expect(await reader.readConfig("Missing_AVD")).toBeNull();
      }));

    test("an empty AVD set reads every name as null", () =>
      withReader([], async (reader) => {
        expect(await reader.readConfig("Pixel_9")).toBeNull();
      }));

    test("each provisioned AVD resolves independently", () =>
      withReader(["Pixel_9", "Tablet_8"], async (reader) => {
        expect(await reader.readConfig("Tablet_8")).toEqual(EMPTY_AVD_CONFIG);
        expect(await reader.readConfig("Pixel_9")).toEqual(EMPTY_AVD_CONFIG);
        expect(await reader.readConfig("Pixel_8")).toBeNull();
      }));

    test("a caller mutating one result does not change the next read", () =>
      withReader(["Pixel_9"], async (reader) => {
        const first = await reader.readConfig("Pixel_9");
        expect(first).not.toBeNull();
        if (first) {
          first.deviceName = "mutated";
          first.hardware = undefined;
        }
        expect(await reader.readConfig("Pixel_9")).toEqual(EMPTY_AVD_CONFIG);
      }));
  });
}
