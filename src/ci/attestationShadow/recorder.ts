import path from "node:path";
import type { FileSystem } from "../../utils/filesystem/DefaultFileSystem";
import { logger } from "../../utils/logger";
import { resolveAutoMobileBaseDir } from "../../utils/tempDir";
import type { Timer } from "../../utils/SystemTimer";
import { classifyShadowOutcome } from "./classify";
import { aggregateShadowMetrics } from "./metrics";
import type { ShadowMetrics, ShadowObservation, ShadowRecord } from "./types";

interface StoredShadowData {
  schemaVersion: 1;
  records: ShadowRecord[];
  metrics: ShadowMetrics;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStoredData(value: unknown): value is StoredShadowData {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    Array.isArray(value.records) &&
    isObject(value.metrics)
  );
}

export function defaultShadowDir(): string {
  return path.join(resolveAutoMobileBaseDir(), "ci-attestation");
}

export class ShadowRecorder {
  private readonly maxRecords: number;
  constructor(
    private readonly options: { fs: FileSystem; timer: Timer; dir: string; maxRecords?: number },
  ) {
    this.maxRecords = options.maxRecords ?? 5000;
  }

  async record(obs: ShadowObservation): Promise<ShadowRecord> {
    const recordedAtMs = this.options.timer.now();
    const record: ShadowRecord = { ...obs, outcome: classifyShadowOutcome(obs), recordedAtMs };
    const existing = await this.readRecords();
    const records = existing.filter(
      (item) =>
        !(item.tier === obs.tier && item.treeHash === obs.treeHash && item.runId === obs.runId),
    );
    records.push(record);
    const retained = records.slice(-this.maxRecords);
    const metrics = aggregateShadowMetrics(retained, recordedAtMs);
    const data: StoredShadowData = { schemaVersion: 1, records: retained, metrics };
    const file = path.join(this.options.dir, "shadow-metrics.json");
    const temporary = `${file}.tmp`;
    await this.options.fs.ensureDir(this.options.dir);
    await this.options.fs.writeFile(temporary, JSON.stringify(data), "utf8");
    await this.options.fs.rename(temporary, file);
    return record;
  }

  async readMetrics(): Promise<ShadowMetrics> {
    const records = await this.readRecords();
    return aggregateShadowMetrics(records, this.options.timer.now());
  }

  private async readRecords(): Promise<ShadowRecord[]> {
    const file = path.join(this.options.dir, "shadow-metrics.json");
    if (!(await this.options.fs.pathExists(file))) {
      // A missing shadow store is the expected initial state.
      logger.debug("CI attestation shadow metrics file is not present yet");
      return [];
    }
    try {
      const text = await this.options.fs.readFile(file, "utf8");
      const parsed: unknown = JSON.parse(text);
      if (!isStoredData(parsed) || !parsed.records.every(isShadowRecord)) {
        throw new Error("Invalid shadow metrics schema");
      }
      return parsed.records;
    } catch (error) {
      logger.warn(
        `Failed to read CI attestation shadow metrics; starting empty: ${String(error)}`,
        error,
      );
      await this.options.fs.rename(file, `${file}.corrupt-${this.options.timer.now()}`);
      return [];
    }
  }
}

function isShadowRecord(value: unknown): value is ShadowRecord {
  if (!isObject(value)) {
    return false;
  }
  return (
    typeof value.tier === "number" &&
    [1, 2, 3].includes(value.tier) &&
    typeof value.treeHash === "string" &&
    typeof value.runId === "string" &&
    ["skip", "advisory", "ignore"].includes(String(value.verdict)) &&
    typeof value.hadAttestation === "boolean" &&
    ["pass", "fail", "cancelled"].includes(String(value.ciResult)) &&
    ["agree", "false-hit", "false-miss", "excluded"].includes(String(value.outcome)) &&
    typeof value.recordedAtMs === "number"
  );
}
