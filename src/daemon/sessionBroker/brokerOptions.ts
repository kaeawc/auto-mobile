import type {
  SessionDeviceCatalog,
  SessionRequirementCapabilities,
  SessionRequirementDefaults,
} from "../../devices/sessionRequirements";
import type { Timer } from "../../utils/SystemTimer";
import type { BindingProcessIdentity } from "./registry/bindingRegistry";
import type { BrokerLimits } from "./admission";
import type { IdlePoolTtlMs } from "./idlePoolExpiry";
import type { SessionBrokerDevicePort } from "./devicePort";
import type { SessionLiveness } from "./sessionDisposition";
import type { SqliteSessionBrokerStore } from "./sqliteStore";

export interface SessionBrokerOptions {
  store: SqliteSessionBrokerStore;
  devices: SessionBrokerDevicePort;
  owner: BindingProcessIdentity;
  limits: BrokerLimits;
  catalog: (platform: "ios" | "android", signal?: AbortSignal) => Promise<SessionDeviceCatalog>;
  defaults: (platform: "ios" | "android") => SessionRequirementDefaults;
  /** Operator-enabled hardware capabilities; omitted capabilities refuse their requests. */
  capabilities?: SessionRequirementCapabilities;
  /** Admission-only lookup; must not start lazy release from inside recovery. */
  sessionDisposition?: (sessionUuid: string) => SessionLiveness | Promise<SessionLiveness>;
  /** Opt in to iOS reuse only after the native reset baseline passes contamination tests. */
  reuseCleanDevices?: boolean;
  /** Opt in to Android reuse only after its native reset strategy passes contamination tests. */
  reuseAndroidCleanDevices?: boolean;
  /** Idle pooled devices of a listed platform are destroyed after this long idle; omitted keeps them. */
  idleTtlMs?: IdlePoolTtlMs;
  /** How long a terminal receipt keeps answering replay; defaults to the broker retention window. */
  receiptRetentionMs?: number;
  /** Maximum pin age for an unacknowledged export. */
  exportRetentionMs?: number;
  cleanupConcurrency?: number;
  /** Per-item pass wait only; native work retains its slot until it settles. */
  cleanupWaitMs?: number;
  /** Caller wait after durable release ownership commits; native cleanup keeps running. */
  releaseReplyBudgetMs?: number;
  timer?: Pick<Timer, "setTimeout" | "clearTimeout"> & Partial<Pick<Timer, "now">>;
}

export function cleanDeviceReuseEnabled(
  platform: "ios" | "android",
  options: Pick<SessionBrokerOptions, "reuseCleanDevices" | "reuseAndroidCleanDevices">,
): boolean {
  return platform === "android"
    ? options.reuseAndroidCleanDevices === true
    : options.reuseCleanDevices === true;
}
