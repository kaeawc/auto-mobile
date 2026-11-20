import type { BootedDevice } from "../../../../models";
import { ActionableError } from "../../../../models/ActionableError";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../../../utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../../../../utils/logger";
import { defaultTimer, type Timer } from "../../../../utils/SystemTimer";
import { PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY } from "../../../observe/android/ctrlProxyProtocol";
import { connectBufferedPrototypeAgent } from "../../ios/connectBufferedPrototypeAgent";
import {
  NodePrototypeAgentConnector,
  type PrototypeAgentClient,
  type PrototypeAgentConnector,
  type PrototypeAgentResumeState,
} from "../../ios/prototypeAgentClient";
import type { DisposableAppRegistry } from "../DisposableAppRegistry";
import { assertDisposableAppId } from "../disposableAppId";

type Attachment = { deviceId: string; client: PrototypeAgentClient; remove(): Promise<void> };
export interface AndroidDisposableAppAttachDependencies {
  registry: DisposableAppRegistry;
  adbFactory?: AdbClientFactory;
  connector?: PrototypeAgentConnector;
  timer?: Timer;
}

/** Owns host connections and adb forwards; installation records survive app exit. */
export class AndroidDisposableAppAttacher {
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private readonly clients = new Map<string, Attachment>();
  private readonly resumeStates = new Map<string, PrototypeAgentResumeState>();
  private readonly pending = new Map<
    string,
    { deviceId: string; promise: Promise<PrototypeAgentClient> }
  >();
  constructor(private readonly deps: AndroidDisposableAppAttachDependencies) {}

  attach(device: BootedDevice, appId: string): Promise<PrototypeAgentClient> {
    if (this.disposed) {
      return Promise.reject(new ActionableError("Disposable app attachment host was disposed."));
    }
    const key = JSON.stringify([device.deviceId, appId]);
    const cached = this.clients.get(key);
    if (cached) {
      return Promise.resolve(cached.client);
    }
    const existing = this.pending.get(key);
    if (existing) {
      return existing.promise;
    }
    const promise = this.connect(device, appId, key).finally(() => this.pending.delete(key));
    this.pending.set(key, { deviceId: device.deviceId, promise });
    return promise;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return (this.disposal ??= Promise.all(
      [
        ...new Set(
          [...this.clients.values(), ...this.pending.values()].map((entry) => entry.deviceId),
        ),
      ].map((deviceId) => this.release(deviceId)),
    ).then(() => this.resumeStates.clear()));
  }

  async release(deviceId: string): Promise<void> {
    try {
      await this.releaseMatching(deviceId);
    } finally {
      for (const key of this.resumeStates.keys()) {
        const [knownDeviceId] = JSON.parse(key) as [string, string];
        if (knownDeviceId === deviceId) {
          this.resumeStates.delete(key);
        }
      }
    }
  }

  /** An uninstall/reinstall invalidates this app's socket and retained delivery cursor. */
  async forget(deviceId: string, appId: string): Promise<void> {
    try {
      await this.releaseMatching(deviceId, appId);
    } finally {
      this.resumeStates.delete(JSON.stringify([deviceId, appId]));
    }
  }

  private async releaseMatching(deviceId: string, appId?: string): Promise<void> {
    const matches = (key: string, entry: { deviceId: string }) =>
      entry.deviceId === deviceId &&
      (appId === undefined || key === JSON.stringify([deviceId, appId]));
    await Promise.allSettled(
      [...this.pending.entries()]
        .filter(([key, entry]) => matches(key, entry))
        .map(([, entry]) => entry.promise),
    );
    await Promise.all(
      [...this.clients.entries()]
        .filter(([key, entry]) => matches(key, entry))
        .map(async ([key, entry]) => {
          this.clients.delete(key);
          entry.client.close();
          await entry.remove();
        }),
    );
  }

  private async connect(
    device: BootedDevice,
    appId: string,
    key: string,
  ): Promise<PrototypeAgentClient> {
    assertDisposableAppId(appId);
    const record = (await this.deps.registry.list(device.deviceId)).find(
      (app) => app.appId === appId,
    );
    const guidance = `Could not attach to ${appId}. Call launchApp with appId "${appId}" and retry; the token may be stale after a reinstall. Reinstall with prototype installApp if needed.`;
    if (!record?.attachToken || device.platform !== "android") {
      throw new ActionableError(guidance);
    }
    const adb = (this.deps.adbFactory ?? defaultAdbClientFactory).create(device);
    let port: number | undefined;
    let removing: Promise<void> | undefined;
    const remove = (): Promise<void> =>
      (removing ??= (async () => {
        if (port !== undefined) {
          try {
            await adb.execute(["forward", "--remove", `tcp:${port}`], { noRetry: true });
          } catch {
            logger.warn(
              "Could not remove disposable app adb forward; release it with adb forward --remove.",
            );
          }
        }
      })());
    try {
      const forwarded = await adb.execute(
        ["forward", "tcp:0", `localabstract:automobile-app-${appId}`],
        { noRetry: true },
      );
      port = forwardedPort(forwarded.stdout);
      if (forwarded.stderr.trim()) {
        throw new ActionableError("adb forward failed.");
      }
      let eventResumeState = this.resumeStates.get(key);
      if (!eventResumeState) {
        eventResumeState = { lastAcknowledgedSequence: 0 };
        this.resumeStates.set(key, eventResumeState);
      }
      const client = await connectBufferedPrototypeAgent(
        port,
        record.attachToken,
        this.deps.connector ?? new NodePrototypeAgentConnector(),
        { timer: this.deps.timer ?? defaultTimer, acknowledgeEvents: true, eventResumeState },
      );
      if (!client.handshake.capabilities.includes(PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY)) {
        client.close();
        throw new ActionableError("Disposable app is missing prototype_persistence_replay_v1.");
      }
      const entry = { deviceId: device.deviceId, client, remove };
      this.clients.set(key, entry);
      let closed = false;
      client.onClosed(() => {
        closed = true;
        if (this.clients.get(key) === entry) {
          this.clients.delete(key);
        }
        void remove();
      });
      if (closed) {
        throw new ActionableError(guidance);
      }
      return client;
    } catch {
      await remove();
      // Socket/adb errors can contain peer-supplied text; discard causes to protect the secret.
      throw new ActionableError(guidance);
    }
  }
}

function forwardedPort(stdout: string): number {
  const text = stdout.trim();
  if (!/^[1-9][0-9]{0,4}$/.test(text) || Number(text) > 65535) {
    throw new ActionableError("adb forward did not return a port in 1..65535.");
  }
  return Number(text);
}
