import type {
  SlotKey,
  SlotPlatform,
  SlotRegistry,
} from "../../../src/daemon/managedSlots/slotRegistry";

/**
 * Bind `stableDeviceId` to slot 0 of a fresh `runnerNamespace` scope, ready and idle (no
 * execution) unless `execSessionUuid` names the slot's live execution.
 */
export async function assignManagedSlotDevice(
  registry: SlotRegistry,
  platform: SlotPlatform,
  stableDeviceId: string,
  runnerNamespace = "runner-a",
  execSessionUuid?: string,
): Promise<SlotKey> {
  const scope = await registry.ensureScope({
    managedHostScope: "host",
    runnerNamespace,
    runnerIncarnation: "boot-1",
  });
  if (scope.kind !== "ready") {
    throw new Error(`scope not ready: ${scope.kind}`);
  }
  const key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
  await registry.initSlot(key, { role: "primary", platform, requestedSpec: {} });
  const committed = await registry.commitBinding(
    key,
    { generation: 0, stableDeviceId: null },
    {
      stableDeviceId,
      deviceName: stableDeviceId,
      resolvedSpec: {},
      specFingerprint: "fp",
      state: "ready",
    },
  );
  if (committed.kind !== "committed") {
    throw new Error(`binding not committed: ${committed.kind}`);
  }
  if (execSessionUuid) {
    const claimed = await registry.claimExecution(
      key,
      { generation: 1, stableDeviceId },
      { daemonId: "daemon", pid: 1, sessionUuid: execSessionUuid },
    );
    if (claimed.kind !== "claimed") {
      throw new Error(`execution not claimed: ${claimed.kind}`);
    }
  }
  return key;
}
