import { logger } from "../../utils/logger";
import type { MemoryAuditResultRepository } from "../../db/memoryAuditResultRepository";
import type { NewMemoryAuditResult } from "../../db/types";
import { redactTypedTextArguments } from "../../utils/redactTypedTextArguments";
import type { MemoryMetrics } from "./MemoryMetricsCollector";

/**
 * Represents a single memory threshold violation
 */
export interface MemoryViolation {
  metric: string;
  threshold: number;
  actual: number;
  severity: "warning" | "critical";
  contributionWeight: number; // 0-1, how much this contributes to the overall issue
}

export interface StoredAuditRecord {
  packageName: string;
  toolName: string;
  toolArgs: unknown;
  metrics: MemoryMetrics;
  violations: MemoryViolation[];
  diagnostics: string | null;
  passed: boolean;
}

/** Persists one memory audit outcome per run; failures are logged, never thrown. */
export class MemoryAuditResultStore {
  constructor(
    private readonly deviceId: string,
    private readonly auditResults: Pick<MemoryAuditResultRepository, "insert">,
  ) {}

  /**
   * Store audit result in database
   */
  async store(record: StoredAuditRecord): Promise<void> {
    const { packageName, toolName, toolArgs, metrics, violations, diagnostics, passed } = record;
    try {
      const now = new Date();
      const sessionId = now.toISOString().split("T")[0]; // YYYY-MM-DD

      const auditResult: NewMemoryAuditResult = {
        device_id: this.deviceId,
        session_id: sessionId,
        package_name: packageName,
        tool_name: toolName,
        tool_args: JSON.stringify(redactTypedTextArguments(toolName, toolArgs)),
        timestamp: new Date().toISOString(),
        passed: passed ? 1 : 0,
        pre_java_heap_mb: metrics.preSnapshot.javaHeapMb,
        pre_native_heap_mb: metrics.preSnapshot.nativeHeapMb,
        pre_total_pss_mb: metrics.preSnapshot.totalPssMb,
        post_java_heap_mb: metrics.postSnapshot.javaHeapMb,
        post_native_heap_mb: metrics.postSnapshot.nativeHeapMb,
        post_total_pss_mb: metrics.postSnapshot.totalPssMb,
        java_heap_growth_mb: metrics.javaHeapGrowthMb,
        native_heap_growth_mb: metrics.nativeHeapGrowthMb,
        total_pss_growth_mb: metrics.totalPssGrowthMb,
        gc_count: metrics.gcCount,
        gc_total_duration_ms: metrics.gcTotalDurationMs,
        unreachable_objects_count: metrics.unreachableObjects?.count || null,
        violations_json: JSON.stringify(violations),
        diagnostics_json: diagnostics,
      };

      await this.auditResults.insert(auditResult);

      logger.info(
        `[MemoryAudit] Stored audit result for ${packageName}/${toolName}: ${passed ? "PASSED" : "FAILED"}`,
      );
    } catch (error) {
      logger.error(`[MemoryAudit] Failed to store audit result: ${error}`);
    }
  }
}
