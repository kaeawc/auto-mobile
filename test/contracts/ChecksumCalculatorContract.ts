import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChecksumCalculator } from "../../src/utils/ChecksumCalculator";

export interface ChecksumCalculatorContractFactory {
  make(expectedChecksum: string): ChecksumCalculator;
  makeFailure(): ChecksumCalculator;
}

export const runChecksumCalculatorContract = (
  description: string,
  factory: ChecksumCalculatorContractFactory,
): void => {
  describe(`ChecksumCalculator contract: ${description}`, function () {
    test("computes a SHA-256 checksum for a file", async function () {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "checksum-contract-"));
      try {
        const filePath = path.join(tempDir, "file.bin");
        const data = Buffer.from("contract checksum data");
        await fs.writeFile(filePath, data);
        const expectedChecksum = crypto.createHash("sha256").update(data).digest("hex");

        const result = await factory.make(expectedChecksum).computeFileSha256(filePath);

        expect(result.checksum).toBe(expectedChecksum);
        expect(["sha256sum", "shasum", "node"]).toContain(result.source);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("rejects a missing file instead of fabricating a checksum", async function () {
      await expect(
        factory.makeFailure().computeFileSha256("/missing-contract-file.bin"),
      ).rejects.toThrow();
    });
  });
};
