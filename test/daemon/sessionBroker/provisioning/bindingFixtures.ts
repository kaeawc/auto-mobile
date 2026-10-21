import type {
  BindingKey,
  BindingPlatform,
  BindingRegistry,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";

/**
 * Bind `stableDeviceId` to binding 0 of a fresh `runnerNamespace` scope, ready and idle (no
 * execution) unless `execSessionUuid` names the binding's live execution.
 */
export async function assignBindingDevice(
  registry: BindingRegistry,
  platform: BindingPlatform,
  stableDeviceId: string,
  runnerNamespace = "runner-a",
  execSessionUuid?: string,
): Promise<BindingKey> {
  const scope = await registry.ensureScope({
    managedHostScope: "host",
    runnerNamespace,
    runnerIncarnation: "boot-1",
  });
  if (scope.kind !== "ready") {
    throw new Error(`scope not ready: ${scope.kind}`);
  }
  const key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
  await registry.initBinding(key, { role: "primary", platform, requestedSpec: {} });
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
