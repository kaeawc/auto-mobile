import type { DeviceInfo } from "../../../models/index";
import { type BackoffInput } from "../../../utils/Backoff";
import type { Timer } from "../../../utils/SystemTimer";
import type {
  BindingDeviceClaims,
  BindingDeviceDeleter,
  BindingInventory,
  ManagedSpecMatcher,
} from "../provisioning/reconciler";
import { BindingJournalInFlight } from "./BindingJournalInFlight";
import {
  type BindingAssignmentRecord,
  type BindingExecOwnerLiveness,
  type BindingJournalEntry,
  type BindingJournalOwner,
  type BindingJournalPhase,
  type BindingRegistry,
} from "./bindingRegistry";

export interface BindingJournalStageBudgets {
  discoveryMs: number;
  claimMs: number;
  matchMs: number;
  deleteGraceMs: number;
}

export interface DriveOptions {
  signal?: AbortSignal;
}

export type BindingJournalOwnerLiveness = (owner: BindingJournalOwner) => boolean;

export interface BindingJournalDependencies {
  registry: BindingRegistry;
  inventory: BindingInventory;
  matcher: ManagedSpecMatcher;
  deleter: BindingDeviceDeleter;
  claims: BindingDeviceClaims;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  stageBudgets?: Partial<BindingJournalStageBudgets>;
  /** This process's identity as a journal owner. */
  owner: BindingJournalOwner;
  /** Whether another owner is still driving its entries; default: its PID is running. */
  isOwnerLive?: BindingJournalOwnerLiveness;
  isExecOwnerLive?: BindingExecOwnerLiveness;
  inFlight?: BindingJournalInFlight;
  backoff?: BackoffInput;
  isBusy?: (device: DeviceInfo) => string | undefined;
}

export type BindingJournalBlockReason =
  | "discovery_incomplete"
  | "device_busy"
  | "cleanup_pending"
  | "cleanup_quarantined"
  | "binding_settling"
  | "binding_in_use"
  | "reconcile_in_progress"
  | "scope_not_valid";

/** Summary of one redrive, for acquisition evidence and logs. */
export interface BindingJournalRedriveRecord {
  entryId: number;
  kind: BindingJournalEntry["kind"];
  phase: BindingJournalPhase;
  outcome: "settled" | "blocked";
  reason?: BindingJournalBlockReason;
}

export type BindingRedriveResult =
  | { kind: "clear"; redriven: BindingJournalRedriveRecord[] }
  | {
      kind: "blocked";
      reason: BindingJournalBlockReason;
      message: string;
      entry: BindingJournalEntry;
      redriven: BindingJournalRedriveRecord[];
    };

export interface BindingJournalPassResult {
  settled: BindingJournalRedriveRecord[];
  blocked: BindingJournalRedriveRecord[];
  /** Entries left to their live owner, in flight here, or not yet due. */
  skipped: number;
}

export interface DeletionStepOptions {
  /** Present when the caller already proved the device listed and unclaimed. */
  device?: DeviceInfo;
  deadlineMs?: number;
  /** Cancels only the delete stage; an unverified delete is recorded for retry. */
  signal?: AbortSignal;
}

export type DeletionStepResult =
  | {
      kind: "deleted";
      entry: BindingJournalEntry;
      assignment: BindingAssignmentRecord;
      evidence?: unknown;
    }
  | {
      kind: "blocked";
      entry: BindingJournalEntry;
      reason: BindingJournalBlockReason;
      message: string;
      evidence?: unknown;
    };

export type Step =
  | { kind: "next"; entry: BindingJournalEntry }
  | { kind: "settled"; entry: BindingJournalEntry }
  | {
      kind: "blocked";
      entry: BindingJournalEntry;
      reason: BindingJournalBlockReason;
      message: string;
    };
