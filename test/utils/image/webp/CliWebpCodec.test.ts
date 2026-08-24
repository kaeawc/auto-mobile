import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../../src/models/ActionableError";
import { CliWebpCodec, isWebpBuffer } from "../../../../src/utils/image/webp/CliWebpCodec";
import type { WebpBinaryProvider } from "../../../../src/utils/image/webp/WebpBinaryResolver";

interface RecordedRun {
  binary: "cwebp" | "dwebp";
  args: string[];
  input: Buffer;
}

/**
 * Fake owner: records argv/input and returns a canned buffer (or throws) so the
 * codec's argv construction and buffer sniffing can be tested without spawning.
 */
class FakeWebpBinaryProvider implements WebpBinaryProvider {
  readonly runs: RecordedRun[] = [];

  constructor(
    private readonly cwebpOutput: Buffer | Error = Buffer.from("RIFFxxxxWEBPencoded"),
    private readonly dwebpOutput: Buffer | Error = Buffer.from("png-output"),
  ) {}

  async resolveCwebp(): Promise<string> {
    return "/tools/cwebp";
  }

  async resolveDwebp(): Promise<string> {
    return "/tools/dwebp";
  }

  async runCwebp(args: string[], input: Buffer): Promise<Buffer> {
    this.runs.push({ binary: "cwebp", args, input });
    if (this.cwebpOutput instanceof Error) {
      throw this.cwebpOutput;
    }
    return this.cwebpOutput;
  }

  async runDwebp(args: string[], input: Buffer): Promise<Buffer> {
    this.runs.push({ binary: "dwebp", args, input });
    if (this.dwebpOutput instanceof Error) {
      throw this.dwebpOutput;
    }
    return this.dwebpOutput;
  }
}

describe("isWebpBuffer", () => {
  test("sniffs RIFF WEBP buffers", () => {
    expect(isWebpBuffer(Buffer.from("524946460000000057454250", "hex"))).toBe(true);
    expect(isWebpBuffer(Buffer.from("89504e470d0a1a0a", "hex"))).toBe(false);
    expect(isWebpBuffer(Buffer.from("RIFF"))).toBe(false);
  });
});

describe("CliWebpCodec", () => {
  test("encodes PNG input through the resolver with quality flags", async () => {
    const provider = new FakeWebpBinaryProvider();
    const codec = new CliWebpCodec(provider);
    const input = Buffer.from("png-data");

    const encoded = await codec.encode(input, { quality: 60 });

    expect(encoded.toString()).toBe("RIFFxxxxWEBPencoded");
    expect(provider.runs).toEqual([
      { binary: "cwebp", args: ["-q", "60", "-o", "-", "--", "-"], input },
    ]);
  });

  test("maps lossless and near-lossless cwebp flags", async () => {
    const provider = new FakeWebpBinaryProvider();
    const codec = new CliWebpCodec(provider);

    await codec.encode(Buffer.from("png"), { lossless: true, quality: 75 });
    await codec.encode(Buffer.from("png"), { nearLossless: true, quality: 40 });

    expect(provider.runs[0].args).toEqual(["-lossless", "-q", "75", "-o", "-", "--", "-"]);
    expect(provider.runs[1].args).toEqual(["-near_lossless", "40", "-o", "-", "--", "-"]);
  });

  test("decodes WebP input through the resolver", async () => {
    const provider = new FakeWebpBinaryProvider();
    const codec = new CliWebpCodec(provider);
    const input = Buffer.from("RIFFxxxxWEBPdata");

    const decoded = await codec.decode(input);

    expect(decoded.toString()).toBe("png-output");
    expect(provider.runs).toEqual([{ binary: "dwebp", args: ["-o", "-", "--", "-"], input }]);
  });

  test("rejects encode output that is not WebP", async () => {
    const provider = new FakeWebpBinaryProvider(Buffer.from("not-webp"));
    const codec = new CliWebpCodec(provider);

    const thrown = await codec.encode(Buffer.from("png")).catch((error) => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(thrown.message).toContain("WebP");
    expect(thrown.message).toContain("AUTOMOBILE_CWEBP_PATH");
  });

  test("rejects decode input that is not WebP before spawning", async () => {
    const provider = new FakeWebpBinaryProvider();
    const codec = new CliWebpCodec(provider);

    const thrown = await codec.decode(Buffer.from("not-webp")).catch((error) => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(thrown.message).toContain("WebP");
    expect(provider.runs).toEqual([]);
  });

  test("propagates resolver execution failures unchanged", async () => {
    const failure = new ActionableError(
      "cwebp failed (exited with code 1: bad webp). Set AUTOMOBILE_CWEBP_PATH to a working cwebp binary.",
    );
    const provider = new FakeWebpBinaryProvider(failure);
    const codec = new CliWebpCodec(provider);

    const thrown = await codec.encode(Buffer.from("png")).catch((error) => error);

    expect(thrown).toBe(failure);
  });
});
