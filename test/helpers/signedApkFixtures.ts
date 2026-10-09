import { readFileSync } from "node:fs";
import { join } from "node:path";

// SHA-256 of the throwaway fixture signing certificates (keytool -list / apksigner verify).
export const SIGNER_A = "f83432a182b5d5d77f32da4e17b9a9fa8d4f344ea6e31476603ba4fd08c1e8ad";
export const SIGNER_B = "2dc8cc04e4dbbe4b149277de6d616b22d9ec0cfa19971fbfa2f1dcebec21660e";

export type SignedApkFixture =
  | "single-a"
  | "single-b"
  | "multi-ab"
  | "v3-only-a"
  | "rotated-b-from-a"
  | "v1-only-a";

export function loadSignedApk(name: SignedApkFixture): Buffer {
  const path = join(import.meta.dir, "../fixtures/android-apk-signing", `${name}.apk.b64`);
  return Buffer.from(readFileSync(path, "utf8"), "base64");
}
