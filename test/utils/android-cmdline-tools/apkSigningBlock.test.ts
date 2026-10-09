import { describe, expect, test } from "bun:test";
import {
  ApkSigningParseError,
  bufferByteSource,
  readApkSigningSchemes,
} from "../../../src/utils/android-cmdline-tools/apkSigningBlock";

import {
  loadSignedApk,
  SIGNER_A,
  SIGNER_B,
  type SignedApkFixture,
} from "../../helpers/signedApkFixtures";

const read = (name: SignedApkFixture) =>
  readApkSigningSchemes(bufferByteSource(loadSignedApk(name)));

describe("readApkSigningSchemes", () => {
  test("reads the v2 and v3 signer of a single-signer APK", async () => {
    const schemes = await read("single-a");
    expect(schemes?.v2?.map((s) => s.sha256)).toEqual([SIGNER_A]);
    expect(schemes?.v3).toEqual([
      { sha256: SIGNER_A, minSdkVersion: 24, maxSdkVersion: 2147483647 },
    ]);
  });

  test("same content signed by different keys yields different identities", async () => {
    const a = await read("single-a");
    const b = await read("single-b");
    expect(a?.v2?.[0]?.sha256).toBe(SIGNER_A);
    expect(b?.v2?.[0]?.sha256).toBe(SIGNER_B);
  });

  test("preserves the complete multi-signer set in signing order", async () => {
    const schemes = await read("multi-ab");
    expect(schemes?.v2?.map((s) => s.sha256)).toEqual([SIGNER_A, SIGNER_B]);
    expect(schemes?.v3).toBeUndefined();
  });

  test("reads the rotated v3.1 signer, its SDK range and lineage", async () => {
    const schemes = await read("rotated-b-from-a");
    expect(schemes?.v2?.map((s) => s.sha256)).toEqual([SIGNER_A]);
    expect(schemes?.v3).toEqual([{ sha256: SIGNER_A, minSdkVersion: 24, maxSdkVersion: 32 }]);
    expect(schemes?.["v3.1"]).toEqual([
      {
        sha256: SIGNER_B,
        minSdkVersion: 33,
        maxSdkVersion: 2147483647,
        lineage: [SIGNER_A, SIGNER_B],
      },
    ]);
  });

  test("returns null for a JAR-signed APK without an APK Signing Block", async () => {
    expect(await read("v1-only-a")).toBeNull();
  });

  test("rejects a non-ZIP source", async () => {
    await expect(readApkSigningSchemes(bufferByteSource(Buffer.from("not a zip")))).rejects.toThrow(
      ApkSigningParseError,
    );
  });

  test("rejects a signing block truncated below its declared size", async () => {
    const apk = loadSignedApk("single-a");
    const eocd = apk.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const cdOffset = apk.readUInt32LE(eocd + 16);
    const corrupt = Buffer.from(apk);
    // Inflate the footer's block size past the start of the file.
    corrupt.writeBigUInt64LE(BigInt(cdOffset + 1000), cdOffset - 24);
    await expect(readApkSigningSchemes(bufferByteSource(corrupt))).rejects.toThrow(
      ApkSigningParseError,
    );
  });
});
