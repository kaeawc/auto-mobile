import type { Platform } from "../models";

export interface DisconnectMonitorEvaluation {
  disconnected: string[];
  missed: Array<{ deviceId: string; misses: number }>;
  skippedAdbUnreachable: boolean;
}

export interface DisconnectMonitorEvaluationInput {
  deviceDisconnectMisses: Map<string, number>;
  confirmedDisconnectedDeviceIds: Set<string>;
  bootedDeviceIds: Set<string>;
  candidateDeviceIds: Set<string>;
  succeededPlatforms: Set<Platform>;
  candidatePlatforms: Map<string, Platform>;
  idleCandidateIds: Set<string>;
  forceDisconnectedDeviceIds?: Set<string>;
  missThreshold: number;
}

export function evaluateDeviceDisconnects(
  input: DisconnectMonitorEvaluationInput
): DisconnectMonitorEvaluation {
  const disconnected: string[] = [];
  const missed: Array<{ deviceId: string; misses: number }> = [];
  const forceDisconnectedDeviceIds = input.forceDisconnectedDeviceIds ?? new Set<string>();

  for (const deviceId of input.candidateDeviceIds) {
    if (forceDisconnectedDeviceIds.has(deviceId)) {
      input.deviceDisconnectMisses.delete(deviceId);
      disconnected.push(deviceId);
      continue;
    }

    if (input.bootedDeviceIds.has(deviceId)) {
      input.deviceDisconnectMisses.delete(deviceId);
      input.confirmedDisconnectedDeviceIds.delete(deviceId);
      forceDisconnectedDeviceIds.delete(deviceId);
      continue;
    }
  }

  if (disconnected.length > 0) {
    return { disconnected, missed, skippedAdbUnreachable: false };
  }

  if (input.bootedDeviceIds.size === 0 && input.candidateDeviceIds.size > 0) {
    return { disconnected, missed, skippedAdbUnreachable: true };
  }

  for (const deviceId of input.candidateDeviceIds) {
    if (input.bootedDeviceIds.has(deviceId)) {
      input.deviceDisconnectMisses.delete(deviceId);
      input.confirmedDisconnectedDeviceIds.delete(deviceId);
      continue;
    }

    if (input.confirmedDisconnectedDeviceIds.has(deviceId)) {
      input.deviceDisconnectMisses.delete(deviceId);
      continue;
    }

    const platform = input.candidatePlatforms.get(deviceId);
    if (
      platform &&
      input.idleCandidateIds.has(deviceId) &&
      !input.succeededPlatforms.has(platform)
    ) {
      input.deviceDisconnectMisses.delete(deviceId);
      continue;
    }

    const misses = Math.min(
      (input.deviceDisconnectMisses.get(deviceId) ?? 0) + 1,
      input.missThreshold
    );
    input.deviceDisconnectMisses.set(deviceId, misses);
    missed.push({ deviceId, misses });
    if (misses >= input.missThreshold) {
      disconnected.push(deviceId);
    }
  }

  return { disconnected, missed, skippedAdbUnreachable: false };
}
