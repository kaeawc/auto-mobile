import { exampleSessionBrokerDeviceName } from "../../src/daemon/sessionBroker/deviceNaming";
import type {
  SessionBrokerDevicePort,
  SessionDevicePreparationOptions,
} from "../../src/daemon/sessionBroker/devicePort";
import { nativeProfile } from "../../src/daemon/sessionBroker/profile";
import type { BrokerResourceRecord } from "../../src/daemon/sessionBroker/store";
import type { SqliteBindingRegistry } from "../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { BindingProcessIdentity } from "../../src/daemon/sessionBroker/registry/bindingRegistry";
import { CountingIdGenerator, type IdGenerator } from "../../src/utils/IdGenerator";

export const FAKE_BROKER_OWNER: BindingProcessIdentity = {
  daemonId: "broker-daemon",
  pid: 101,
  processGenerationToken: "start-a",
};

/** Real registry ownership with fake platform operations; does not claim native reset coverage. */
export class FakeNativePort implements SessionBrokerDevicePort {
  readonly prepared: string[] = [];
  readonly destroyed: string[] = [];
  readonly released: string[] = [];
  readonly resetResources: string[] = [];
  readonly dirty = new Set<string>();
  readonly sessions = new Map<string, BrokerResourceRecord>();

  canDestroy = true;
  canRelease = true;
  canReset = true;
  prepareError: Error | undefined;
  resetError: Error | undefined;
  prepareHook: ((options: SessionDevicePreparationOptions) => Promise<void>) | undefined;
  releaseHook: (() => Promise<void>) | undefined;

  constructor(
    private readonly registry: SqliteBindingRegistry,
    readonly sessionIds: IdGenerator = new CountingIdGenerator("session"),
    private readonly owner: BindingProcessIdentity = FAKE_BROKER_OWNER,
  ) {}

  async prepare(resource: BrokerResourceRecord, options: SessionDevicePreparationOptions) {
    this.prepared.push(resource.resourceId);
    await this.prepareHook?.(options);
    const key = { scopeKey: resource.scopeKey, bindingIndex: resource.allocationIndex };
    const profile = nativeProfile(resource);
    await this.registry.initBinding(key, {
      platform: profile.platform,
      role: "primary",
      requestedSpec: profile,
    });
    let assignment = await this.registry.getAssignment(key);
    if (!assignment) {
      throw new Error("Missing fake binding");
    }
    if (!assignment.stableDeviceId) {
      const bound = await this.registry.commitBinding(key, assignment, {
        stableDeviceId: `device-${resource.resourceId}`,
        deviceName: exampleSessionBrokerDeviceName(resource.resourceId),
        resolvedSpec: profile,
        specFingerprint: "fake-native",
        state: "ready",
      });
      if (bound.kind !== "committed") {
        throw new Error(`Fake binding failed: ${bound.kind}`);
      }
      assignment = bound.assignment;
    }
    const sessionId = this.sessionIds.next();
    const claimed = await this.registry.claimExecution(key, assignment, {
      ...this.owner,
      sessionUuid: sessionId,
    });
    if (claimed.kind !== "claimed") {
      throw new Error(`Fake execution claim failed: ${claimed.kind}`);
    }
    this.sessions.set(sessionId, resource);
    if (this.prepareError) {
      throw this.prepareError;
    }
    return { sessionId, profile };
  }

  async release(sessionId: string) {
    this.released.push(sessionId);
    await this.releaseHook?.();
    if (!this.canRelease) {
      return { settled: false };
    }
    const resource = this.sessions.get(sessionId);
    if (resource) {
      await this.registry.releaseExecution(
        { scopeKey: resource.scopeKey, bindingIndex: resource.allocationIndex },
        sessionId,
      );
      this.sessions.delete(sessionId);
    }
    return { settled: true };
  }

  async destroy(resource: BrokerResourceRecord): Promise<"absent" | "pending"> {
    if (!this.canDestroy) {
      return "pending";
    }
    const key = { scopeKey: resource.scopeKey, bindingIndex: resource.allocationIndex };
    let assignment = await this.registry.getAssignment(key);
    if (assignment?.execOwner) {
      if (!(await this.release(assignment.execOwner.sessionUuid)).settled) {
        return "pending";
      }
      assignment = await this.registry.getAssignment(key);
    }
    if (assignment?.stableDeviceId) {
      const cleared = await this.registry.commitBinding(key, assignment, {
        stableDeviceId: null,
        deviceName: null,
        resolvedSpec: null,
        specFingerprint: null,
        state: "ready",
      });
      if (cleared.kind !== "committed") {
        return "pending";
      }
    }
    this.destroyed.push(resource.resourceId);
    this.dirty.delete(resource.resourceId);
    return "absent";
  }

  async reset(resource: BrokerResourceRecord): Promise<"clean" | "pending"> {
    this.resetResources.push(resource.resourceId);
    if (this.resetError) {
      throw this.resetError;
    }
    if (!this.canReset) {
      return "pending";
    }
    this.dirty.delete(resource.resourceId);
    return "clean";
  }
}
