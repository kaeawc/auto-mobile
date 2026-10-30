import type { DisconnectCandidateIncarnation, OfflineEpisode } from "./disconnectMonitor";
import { DeviceLossMisses } from "./deviceLossMisses";

export class DeviceLossState {
  readonly misses: DeviceLossMisses;
  readonly missIncarnations: Map<string, DisconnectCandidateIncarnation>;
  readonly confirmedDisconnectedIds: Set<string>;
  readonly forceDisconnectedIds: Set<string>;
  readonly forceDisconnectedGenerations: Map<string, number>;

  // Serials that already had one bounded 'adb -s <serial> reconnect' this offline
  // episode (#7536). Pruned each sweep by pruneStaleOfflineRecoveryAttempts so
  // a later episode for the same serial gets a fresh attempt.
  offlineRecoveryAttemptedIds: Set<string>;
  offlineRecoveryAttemptedIncarnations: Map<string, number | string>;

  // Start of each candidate's current transitional-state episode (#11090, #11592):
  // adb offline/unauthorized and simctl Booting/Shutting Down sweeps run against
  // OFFLINE_DEVICE_DISCONNECT_BUDGET_MS, not the miss count.
  readonly offlineEpisodes: Map<string, OfflineEpisode>;

  constructor(initial: Partial<DeviceLossState> = {}) {
    this.misses = initial.misses ?? new DeviceLossMisses();
    this.missIncarnations = initial.missIncarnations ?? new Map();
    this.confirmedDisconnectedIds = initial.confirmedDisconnectedIds ?? new Set();
    this.forceDisconnectedIds = initial.forceDisconnectedIds ?? new Set();
    this.forceDisconnectedGenerations = initial.forceDisconnectedGenerations ?? new Map();
    this.offlineRecoveryAttemptedIds = initial.offlineRecoveryAttemptedIds ?? new Set();
    this.offlineRecoveryAttemptedIncarnations =
      initial.offlineRecoveryAttemptedIncarnations ?? new Map();
    this.offlineEpisodes = initial.offlineEpisodes ?? new Map();
  }
}
