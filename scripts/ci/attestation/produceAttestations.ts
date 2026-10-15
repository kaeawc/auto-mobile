import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TREE_INPUT_HASH_ALGORITHM,
  Clock,
  AttestationEnvelope,
  AttestationLane,
  AttestationPayload,
  AttestationSignature,
  GateResult,
  LANE_TIER,
  attestationId,
  canonicalizePayload,
  compareCodeUnits,
} from "./attestationSchema";

export const LANE_INPUT_PATHS: Record<AttestationLane, readonly string[]> = {
  node: [
    "src",
    "test",
    "schemas",
    "scripts",
    "package.json",
    "bun.lock",
    "tsconfig.json",
    ".oxlintrc.json",
    "oxlint-plugins",
    "turbo.json",
    "bunfig.toml",
    "docs",
    "docs-assets",
    "mkdocs.yml",
    ".github",
    ".gitattributes",
    ".oxfmtrc.json",
    "tsconfig.dead-code.json",
    "knip.json",
  ],
  android: ["android"],
  ios: ["ios"],
};
export interface TreeProbe {
  headId(): Promise<string>;
  dirtyPaths(paths: readonly string[]): Promise<string[]>;
  inputEntries(
    paths: readonly string[],
  ): Promise<Array<{ path: string; id: string; mode: string }>>;
}
export interface InputHasher {
  hash(lane: AttestationLane, probe: TreeProbe): Promise<{ hash: string; algorithm: string }>;
}
export class TreeEntriesInputHasher implements InputHasher {
  async hash(
    lane: AttestationLane,
    probe: TreeProbe,
  ): Promise<{ hash: string; algorithm: string }> {
    const entries = await probe.inputEntries(LANE_INPUT_PATHS[lane]);
    if (entries.length === 0) {
      throw new Error("empty input entries");
    }
    const content = [...entries]
      .sort((a, b) => compareCodeUnits(a.path, b.path))
      .map(({ path, id, mode }) => `${JSON.stringify([path, id, mode])}\n`)
      .join("");
    return {
      hash: createHash("sha256").update(content).digest("hex"),
      algorithm: TREE_INPUT_HASH_ALGORITHM,
    };
  }
}
export interface Signer {
  sign(canonicalPayload: string): Promise<AttestationSignature | null>;
}
export class UnsignedSigner implements Signer {
  async sign(_canonicalPayload: string): Promise<null> {
    return null;
  }
}
export interface AttestationSink {
  publish(env: AttestationEnvelope, id: string): Promise<void>;
}
export class NoopSink implements AttestationSink {
  async publish(_env: AttestationEnvelope, _id: string): Promise<void> {}
}
export interface FileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, content: string, encoding: "utf8"): Promise<void>;
}
const defaultFileSystem: FileSystem = { mkdir, writeFile };
export class LocalFileSink implements AttestationSink {
  constructor(
    private readonly dir: string,
    private readonly fs: FileSystem = defaultFileSystem,
  ) {}
  async publish(env: AttestationEnvelope, id: string): Promise<void> {
    await this.fs.mkdir(this.dir, { recursive: true });
    await this.fs.writeFile(
      join(this.dir, `${env.payload.lane}-${id}.json`),
      `${JSON.stringify(env, null, 2)}\n`,
      "utf8",
    );
  }
}
export class CompositeSink implements AttestationSink {
  constructor(
    private readonly sinks: readonly AttestationSink[],
    private readonly warn: (message: string) => void,
  ) {}
  async publish(env: AttestationEnvelope, id: string): Promise<void> {
    const failures: string[] = [];
    for (const sink of this.sinks) {
      try {
        await sink.publish(env, id);
      } catch (error) {
        const detail = String(error);
        this.warn(`attestation sink failed: ${detail}`);
        failures.push(detail);
      }
    }
    if (failures.length > 0) {
      throw new Error(`attestation sinks failed: ${failures.join("; ")}`);
    }
  }
}
export interface ProduceOptions {
  lanes: Array<{
    lane: AttestationLane;
    gates: GateResult[];
    scope?: "full" | "partial";
    scopeNote?: string;
    expectedHead?: string;
    startedDirty?: boolean;
  }>;
  probe: TreeProbe;
  hasher: InputHasher;
  signer: Signer;
  sink: AttestationSink;
  clock: Clock;
  environment: AttestationPayload["environment"];
  warn: (message: string) => void;
}
export type LaneOutcome = {
  lane: AttestationLane;
  outcome: "attested" | "skipped-dirty" | "skipped-error";
  id?: string;
  detail?: string;
};
export async function produceAttestations(opts: ProduceOptions): Promise<LaneOutcome[]> {
  const output: LaneOutcome[] = [];
  for (const item of opts.lanes) {
    try {
      if (item.gates.length === 0) {
        output.push({ lane: item.lane, outcome: "skipped-error", detail: "no gates" });
        continue;
      }
      const paths = LANE_INPUT_PATHS[item.lane];
      const dirty = await opts.probe.dirtyPaths(paths);
      if (item.startedDirty || dirty.length > 0) {
        output.push({
          lane: item.lane,
          outcome: "skipped-dirty",
          detail: item.startedDirty ? "dirty at start" : dirty.slice(0, 5).join(", "),
        });
        continue;
      }
      const commitId = await opts.probe.headId();
      const input = await opts.hasher.hash(item.lane, opts.probe);
      const payload: AttestationPayload = {
        payloadType: `auto-mobile.prepush.${item.lane}`,
        payloadVersion: 1,
        tier: LANE_TIER[item.lane],
        lane: item.lane,
        inputHash: input.hash,
        inputHashAlgorithm: input.algorithm,
        commitId,
        scope: item.scope ?? "partial",
        scopeNote: item.scopeNote ?? "",
        gates: item.gates,
        overall: item.gates.some((gate) => gate.status === "fail") ? "fail" : "pass",
        environment: opts.environment,
        producedAt: new Date(opts.clock.nowMs()).toISOString(),
      };
      const signature = await opts.signer.sign(canonicalizePayload(payload));
      const env: AttestationEnvelope = { envelopeVersion: 1, payload, signature };
      const finalHead = await opts.probe.headId();
      if (finalHead !== commitId || (item.expectedHead && finalHead !== item.expectedHead)) {
        throw new Error("HEAD moved during run");
      }
      const id = attestationId(env);
      await opts.sink.publish(env, id);
      output.push({ lane: item.lane, outcome: "attested", id });
    } catch (error) {
      const detail = String(error);
      opts.warn(`attestation ${item.lane} failed: ${detail}`);
      output.push({ lane: item.lane, outcome: "skipped-error", detail });
    }
  }
  return output;
}
