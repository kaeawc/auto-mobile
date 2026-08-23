import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

export type Sha256Source = "sha256sum" | "shasum" | "node";

export interface ChecksumCalculator {
  computeFileSha256(filePath: string): Promise<{ checksum: string; source: Sha256Source }>;
}

export class DefaultChecksumCalculator implements ChecksumCalculator {
  public async computeFileSha256(
    filePath: string,
  ): Promise<{ checksum: string; source: Sha256Source }> {
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });
    return { checksum: hash.digest("hex"), source: "node" };
  }
}
