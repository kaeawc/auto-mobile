import { describe, expect, test } from "bun:test";
import { unknownSimulatorIdentifierMessage } from "../../../src/utils/ios-cmdline-tools/simulatorCatalogRefusal";

// An unknown Apple simulator identifier names the accepted ones and, for a short form, the full
// identifier to pass (#17090).

const VISION = "com.apple.CoreSimulator.SimDeviceType.Apple-Vision-Pro-4K";
const TV = "com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-3rd-generation-4K";

describe("unknownSimulatorIdentifierMessage", () => {
  const message = (requested: string, identifiers: string[]) =>
    unknownSimulatorIdentifierMessage({
      kind: "Apple Vision Pro device type",
      requested,
      identifiers,
      catalog: "automobile:devices/images/visionos",
    });

  test("a short form of one listed identifier names the full identifier", () => {
    expect(message("apple-vision-pro-4k", [VISION, TV])).toBe(
      `Unknown Apple Vision Pro device type 'apple-vision-pro-4k'. Pass the full CoreSimulator ` +
        `identifier '${VISION}'. Available: ${VISION}, ${TV} (listed by automobile:devices/images/visionos).`,
    );
  });

  test("an unmatched or ambiguous short form only lists what is available", () => {
    expect(message("Apple-Vision-Pro-8K", [VISION])).not.toContain("Pass the full");
    expect(message("4K", [VISION, TV])).not.toContain("Pass the full");
    expect(message("Apple-Vision-Pro-4K", [])).toContain("Available: none installed");
  });
});
