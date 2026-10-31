import { describe, expect, test } from "bun:test";
import {
  OEM_IDENTITY_BUILD_FIELDS,
  oemIdentityDescriptorSchema,
} from "../../../src/features/utility/OemIdentityDescriptor";

const samsung = {
  personaId: "samsung-oneui" as const,
  version: 1,
  props: {
    "ro.product.manufacturer": "samsung",
    "ro.product.brand": "samsung",
    "ro.product.model": "SM-S921B",
    "ro.product.vendor.manufacturer": "samsung",
  },
  features: ["com.samsung.feature.samsung_experience_mobile"],
  evidence: { status: "vendor_documented" as const, note: "Build fields of a Galaxy S24." },
};

function issues(input: unknown): string[] {
  const result = oemIdentityDescriptorSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("oemIdentityDescriptorSchema (#14059)", () => {
  test("accepts Build identity props on any partition and an OEM feature", () => {
    expect(oemIdentityDescriptorSchema.parse(samsung)).toEqual(samsung);
  });

  test("covers the Build fields an app branches on", () => {
    expect([...OEM_IDENTITY_BUILD_FIELDS]).toEqual([
      "manufacturer",
      "brand",
      "model",
      "device",
      "name",
    ]);
  });

  test("refuses integrity signals and any prop outside the identity fields", () => {
    for (const prop of [
      "ro.build.fingerprint",
      "ro.build.tags",
      "ro.build.type",
      "ro.debuggable",
      "ro.secure",
      "ro.boot.verifiedbootstate",
      "ro.product.first_api_level",
      "ro.product.cpu.abi",
      "ro.product.bootimage.model",
      "persist.sys.timezone",
    ]) {
      expect(issues({ ...samsung, props: { [prop]: "x" } })).toEqual([
        expect.stringContaining("not an identity prop"),
      ]);
    }
  });

  test("refuses prop values a device shell could interpret", () => {
    for (const value of ["", "a;reboot", "$(id)", "a b`c", "(x)", "x".repeat(92), "line\nbreak"]) {
      expect(issues({ ...samsung, props: { "ro.product.model": value } })).not.toEqual([]);
    }
    expect(issues({ ...samsung, props: { "ro.product.model": "Pixel 9 Pro XL_2.0-b+c" } })).toEqual(
      [],
    );
  });

  test("refuses platform features, malformed names and repeats", () => {
    for (const features of [
      ["android.hardware.type.watch"],
      ["android.software.leanback"],
      ["no_dots"],
      ["com.samsung.feature.x;rm"],
      ["com.oem.feature.a", "com.oem.feature.a"],
    ]) {
      expect(issues({ ...samsung, features })).not.toEqual([]);
    }
  });

  test("needs at least one prop or feature and a known persona", () => {
    expect(issues({ ...samsung, props: {}, features: [] })).toEqual([
      expect.stringContaining("at least one prop or feature"),
    ]);
    expect(issues({ ...samsung, personaId: "nokia" })).not.toEqual([]);
  });

  test("rejects unknown fields so an APK or image reference cannot ride along", () => {
    expect(issues({ ...samsung, apk: "https://example.com/oem.apk" })).not.toEqual([]);
  });
});
