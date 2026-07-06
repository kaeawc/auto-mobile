import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../../src/models/ActionableError";
import { CliWebpCodec, isWebpBuffer } from "../../../../src/utils/image/webp/CliWebpCodec";
import { FakeChildProcess } from "../../../fakes/FakeChildProcess";
import { FakeProcessExecutor } from "../../../fakes/FakeProcessExecutor";

class FakeWebpBinaryResolver {
  constructor(
    private readonly cwebpPath = "/tools/cwebp",
    private readonly dwebpPath = "/tools/dwebp"
  ) {}

  async resolveCwebp(): Promise<string> {
    return this.cwebpPath;
  }

  async resolveDwebp(): Promise<string> {
    return this.dwebpPath;
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
  test("encodes PNG input through cwebp stdin/stdout with quality flags", async () => {
    const processExecutor = new FakeProcessExecutor();
    const child = new FakeChildProcess();
    child.addStdoutData(Buffer.from("RIFFxxxxWEBPencoded"));
    processExecutor.setNextSpawnProcess(child);
    const codec = new CliWebpCodec(new FakeWebpBinaryResolver(), processExecutor);
    const input = Buffer.from("png-data");

    const encodedPromise = codec.encode(input, { quality: 60 });
    child.simulateSpawn();
    child.simulateExit(0);
    const encoded = await encodedPromise;

    expect(encoded.toString()).toBe("RIFFxxxxWEBPencoded");
    expect(child.getStdinData()).toEqual(input);
    expect(processExecutor.getSpawnedProcesses()).toMatchObject([
      {
        command: "/tools/cwebp",
        args: ["-q", "60", "-o", "-", "--", "-"]
      }
    ]);
  });

  test("maps lossless and near-lossless cwebp flags", async () => {
    const processExecutor = new FakeProcessExecutor();
    for (const options of [{ lossless: true, quality: 75 }, { nearLossless: true, quality: 40 }]) {
      const child = new FakeChildProcess();
      child.addStdoutData(Buffer.from("RIFFxxxxWEBPencoded"));
      processExecutor.setNextSpawnProcess(child);
      const promise = new CliWebpCodec(new FakeWebpBinaryResolver(), processExecutor).encode(Buffer.from("png"), options);
      child.simulateSpawn();
      child.simulateExit(0);
      await promise;
    }

    const spawns = processExecutor.getSpawnedProcesses();
    expect(spawns[0].args).toEqual(["-lossless", "-q", "75", "-o", "-", "--", "-"]);
    expect(spawns[1].args).toEqual(["-near_lossless", "40", "-o", "-", "--", "-"]);
  });

  test("decodes WebP input through dwebp stdin/stdout", async () => {
    const processExecutor = new FakeProcessExecutor();
    const child = new FakeChildProcess();
    child.addStdoutData(Buffer.from("png-output"));
    processExecutor.setNextSpawnProcess(child);
    const codec = new CliWebpCodec(new FakeWebpBinaryResolver(), processExecutor);
    const input = Buffer.from("RIFFxxxxWEBPdata");

    const decodedPromise = codec.decode(input);
    child.simulateSpawn();
    child.simulateExit(0);
    const decoded = await decodedPromise;

    expect(decoded.toString()).toBe("png-output");
    expect(child.getStdinData()).toEqual(input);
    expect(processExecutor.getSpawnedProcesses()).toMatchObject([
      {
        command: "/tools/dwebp",
        args: ["-o", "-", "--", "-"]
      }
    ]);
  });

  test("rejects decode input that is not WebP", async () => {
    const codec = new CliWebpCodec(new FakeWebpBinaryResolver(), new FakeProcessExecutor());

    const thrown = await codec.decode(Buffer.from("not-webp")).catch(error => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(thrown.message).toContain("WebP");
  });

  test("surfaces subprocess failures as actionable errors", async () => {
    const processExecutor = new FakeProcessExecutor();
    const child = new FakeChildProcess();
    child.addStderrData("bad webp");
    processExecutor.setNextSpawnProcess(child);
    const codec = new CliWebpCodec(new FakeWebpBinaryResolver(), processExecutor);

    const encodedPromise = codec.encode(Buffer.from("png"));
    child.simulateSpawn();
    child.simulateExit(1);
    const thrown = await encodedPromise.catch(error => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(thrown.message).toContain("cwebp");
    expect(thrown.message).toContain("AUTOMOBILE_CWEBP_PATH");
    expect(thrown.message).toContain("bad webp");
  });

  test("surfaces stdin write failures as actionable errors", async () => {
    const processExecutor = new FakeProcessExecutor();
    const child = new FakeChildProcess();
    child.setStdinError("write EPIPE");
    processExecutor.setNextSpawnProcess(child);
    const codec = new CliWebpCodec(new FakeWebpBinaryResolver(), processExecutor);

    const encodedPromise = codec.encode(Buffer.from("png"));
    child.simulateSpawn();
    child.simulateExit(1);
    const thrown = await encodedPromise.catch(error => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(thrown.message).toContain("cwebp");
    expect(thrown.message).toContain("AUTOMOBILE_CWEBP_PATH");
    expect(thrown.message).toContain("write EPIPE");
  });
});
