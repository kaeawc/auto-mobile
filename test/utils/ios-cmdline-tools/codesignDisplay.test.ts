import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCodesignDisplay } from "../../../src/utils/ios-cmdline-tools/codesignDisplay";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/ios-signing", name), "utf8");

describe("parseCodesignDisplay (#14099)", () => {
  test("an ad-hoc Simulator signature has no team or certificate chain", () => {
    expect(parseCodesignDisplay(fixture("codesign-dvvv-simulator-adhoc.txt"))).toEqual({
      identifier: "dev.jasonpearson.automobile.Playground",
      format: "app bundle with Mach-O thin (arm64)",
      teamId: null,
      authorities: [],
      signingIdentity: null,
      adHoc: true,
      cdHash: "12ea874d0000bc74673a1bb4cc6a3ef5a52807f3",
      signedTime: null,
    });
  });

  test("a development signature reports team, leaf identity and the lowercased CDHash", () => {
    expect(parseCodesignDisplay(fixture("codesign-dvvv-development.txt"))).toEqual({
      identifier: "dev.jasonpearson.automobile.Playground",
      format: "app bundle with Mach-O thin (arm64)",
      teamId: "ABCDE12345",
      authorities: [
        "Apple Development: Jane Appleseed (Q7RST8UVW9)",
        "Apple Worldwide Developer Relations Certification Authority",
        "Apple Root CA",
      ],
      signingIdentity: "Apple Development: Jane Appleseed (Q7RST8UVW9)",
      adHoc: false,
      cdHash: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      signedTime: "Oct 21, 2026 at 09:12:44",
    });
  });

  test("the adhoc CodeDirectory flag alone marks an ad-hoc signature", () => {
    const output = "CodeDirectory v=20400 size=1 flags=0x10002(adhoc,runtime) hashes=1+0\n";
    expect(parseCodesignDisplay(output).adHoc).toBe(true);
  });

  test("indented continuation lines are not read as fields", () => {
    expect(
      parseCodesignDisplay("Launch Constraints:\n\tIdentifier=nested\n").identifier,
    ).toBeNull();
  });
});
