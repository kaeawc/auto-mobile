import { DEFAULT_OBSERVE_MCP_TIMEOUT_MS } from "../../src/daemon/mcpRequestTimeout";
import {
  DEFAULT_VM_SNAPSHOT_TIMEOUT_MS,
  SNAPSHOT_MCP_TIMEOUT_HEADROOM_MS,
} from "../../src/features/snapshot/deviceSnapshotTimeout";
import { BARRIER_TIMEOUT_MS } from "../../src/features/action/coordinationTimeout";
import { WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS } from "../../src/features/observe/waitForTimeout";
import { DEFAULT_EXPLORE_TIMEOUT_MS } from "../../src/features/navigation/exploreTimeout";
import {
  SHARED_STORAGE_PUSH_TIMEOUT_MS,
  APP_FILE_PUSH_TIMEOUT_MS,
  FILE_TRANSFER_MCP_TIMEOUT_HEADROOM_MS,
} from "../../src/features/storage/fileTransferTimeout";

export interface ArgumentBudgetCase {
  tool: string;
  defaultFloor: number;
  suppliedFloor: number;
  argumentsFor: (value: unknown) => Record<string, unknown>;
  supplied: unknown;
  oversized: unknown;
}

const waitCase = (tool: string, field: string, defaultMs: number): ArgumentBudgetCase => ({
  tool,
  defaultFloor: defaultMs + WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
  suppliedFloor: 600_000 + WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
  argumentsFor: (value) => ({ [field]: value }),
  supplied: 600_000,
  oversized: Number.MAX_SAFE_INTEGER,
});

const fileCase = (tool: string, pushMs: number): ArgumentBudgetCase => ({
  tool,
  defaultFloor: pushMs + FILE_TRANSFER_MCP_TIMEOUT_HEADROOM_MS,
  suppliedFloor: 3 * pushMs + FILE_TRANSFER_MCP_TIMEOUT_HEADROOM_MS,
  argumentsFor: (value) => ({ files: value }),
  supplied: Array.from({ length: 3 }, () => ({ destinationPath: "fixture", contentText: "x" })),
  oversized: new Array(100),
});

export const MCP_ARGUMENT_BUDGET_CASES: readonly ArgumentBudgetCase[] = [
  {
    tool: "deviceSnapshot",
    defaultFloor: DEFAULT_VM_SNAPSHOT_TIMEOUT_MS + SNAPSHOT_MCP_TIMEOUT_HEADROOM_MS,
    suppliedFloor: 600_000 + SNAPSHOT_MCP_TIMEOUT_HEADROOM_MS,
    argumentsFor: (value) => ({ vmSnapshotTimeoutMs: value }),
    supplied: 600_000,
    oversized: Number.MAX_SAFE_INTEGER,
  },
  {
    ...waitCase("observe", "timeout", 5000),
    defaultFloor: DEFAULT_OBSERVE_MCP_TIMEOUT_MS,
    argumentsFor: (value) => ({ waitFor: { elementId: "missing", timeout: value } }),
  },
  waitCase("barrier", "timeout", BARRIER_TIMEOUT_MS),
  waitCase("criticalSection", "timeout", BARRIER_TIMEOUT_MS),
  waitCase("explore", "timeoutMs", DEFAULT_EXPLORE_TIMEOUT_MS),
  fileCase("stageSharedStorage", SHARED_STORAGE_PUSH_TIMEOUT_MS),
  fileCase("stageSharedStorageFixtures", SHARED_STORAGE_PUSH_TIMEOUT_MS),
  fileCase("putAppFile", APP_FILE_PUSH_TIMEOUT_MS),
];

export const MALFORMED_MCP_BUDGETS: readonly unknown[] = [
  "600000",
  -1,
  0,
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER,
  { length: Number.MAX_SAFE_INTEGER },
];
