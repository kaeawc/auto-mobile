import type { BootedDevice } from "../models";
import { ActionableError } from "../models/ActionableError";
import type { MutationRecorder } from "../daemon/sessionBroker/mutations/recorder";
import type { MutationValue } from "../daemon/sessionBroker/mutations/types";
import { logger } from "../utils/logger";
import { deviceToolMutations, type ToolMutation } from "./deviceMutationAdapters";
import {
  DefaultMutationPriorReader,
  type MutationObservationReaders,
  type MutationPriorReader,
} from "./deviceMutationPriorReader";
import { getAbortSignal, runWithAbortSignal } from "../utils/AbortContext";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { DefaultAndroidBuildToolsLocator } from "../utils/android-cmdline-tools/AndroidBuildToolsLocator";
import { DefaultHostCommandExecutor } from "../utils/HostCommandExecutor";
import { AndroidInstallPackageTools } from "../features/action/AndroidInstallPackageTools";
import { IosAppInstaller } from "../features/action/IosAppInstaller";
import type { DaemonContext } from "../daemon/daemonContext";

export function createRecording(
  context: {
    sessionManager():
      | Pick<
          NonNullable<ReturnType<DaemonContext["sessionManager"]>>,
          "getBaseSessionOfDerivedLabel" | "peekSession"
        >
      | undefined;
    sessionBrokerService():
      | Pick<
          NonNullable<ReturnType<DaemonContext["sessionBrokerService"]>>,
          "recoverMutationRecorder"
        >
      | undefined;
  },
  observationReaders: Partial<MutationObservationReaders> = {},
): DeviceMutationRecording {
  return new SessionDeviceMutationRecording(
    (sessionUuid) => {
      const sessions = context.sessionManager();
      if (sessions?.getBaseSessionOfDerivedLabel(sessionUuid)) {
        return undefined;
      }
      return (
        sessions?.peekSession(sessionUuid)?.mutationRecorder ??
        context.sessionBrokerService()?.recoverMutationRecorder(sessionUuid)
      );
    },
    new DefaultMutationPriorReader(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      observationReaders,
    ),
  );
}

export interface MutationArtifactReader {
  appId(
    device: BootedDevice,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
}

export function createDefaultMutationArtifactReader(
  androidFor: (device: BootedDevice) => Pick<AndroidInstallPackageTools, "extractPackageName"> = (
    device,
  ) =>
    new AndroidInstallPackageTools(
      defaultAdbClientFactory.create(device),
      new DefaultAndroidBuildToolsLocator(),
      new DefaultHostCommandExecutor(),
    ),
  iosFor: (device: BootedDevice) => Pick<IosAppInstaller, "resolveAppBundleId"> = (device) =>
    new IosAppInstaller(
      device,
      {},
      () => undefined,
      async () => undefined,
    ),
): MutationArtifactReader {
  return {
    async appId(
      device: BootedDevice,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<string | undefined> {
      signal?.throwIfAborted();
      if (typeof args.artifactPath !== "string") {
        return undefined;
      }
      try {
        const appId =
          device.platform === "android"
            ? (await androidFor(device).extractPackageName(args.artifactPath, signal)).packageName
            : await iosFor(device).resolveAppBundleId(args.artifactPath);
        signal?.throwIfAborted();
        return appId;
      } catch (error) {
        logger.warn(
          "Cannot identify install artifact; recording an unobservable mutation prior",
          error,
        );
        signal?.throwIfAborted();
        return undefined;
      }
    },
  };
}

export interface DeviceMutationRecording {
  beforeToolCall(
    name: string,
    args: Record<string, unknown>,
    device: BootedDevice,
    sessionUuid?: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

/**
 * Captures intent and trustworthy priors for best-effort reverts, not keep-booted admission.
 * Unobservable priors remain journaled; keep-booted cleaning runs unconditionally.
 */
export class SessionDeviceMutationRecording implements DeviceMutationRecording {
  constructor(
    private readonly recorderFor: (
      sessionUuid: string,
    ) => MutationRecorder | undefined | Promise<MutationRecorder | undefined>,
    private readonly reader: MutationPriorReader = new DefaultMutationPriorReader(),
    private readonly artifactReader: MutationArtifactReader = createDefaultMutationArtifactReader(),
  ) {}

  async beforeToolCall(
    name: string,
    args: Record<string, unknown>,
    device: BootedDevice,
    sessionUuid?: string,
    signal: AbortSignal | undefined = getAbortSignal(),
  ): Promise<void> {
    let mutations = deviceToolMutations(name, args);
    if (mutations.length === 0) {
      return;
    }
    signal?.throwIfAborted();
    if (!sessionUuid) {
      return;
    }
    try {
      const recorder = await this.recorderFor(sessionUuid);
      signal?.throwIfAborted();
      if (!recorder) {
        // Non-broker sessions intentionally have no recorder and need no recovery.
        return;
      }
      if (
        recorder.scope.sessionUuid !== sessionUuid ||
        recorder.scope.deviceId !== device.deviceId
      ) {
        throw new ActionableError(
          "Device mutation recorder must match the admitted broker session and device",
        );
      }
      if (name === "installApp") {
        const appId = await runWithAbortSignal(signal, () =>
          this.artifactReader.appId(device, args, signal),
        );
        mutations = deviceToolMutations(name, { ...args, appId });
      }
      await this.recordMutations(name, device, recorder, mutations, signal);
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn("Device mutation recording failed; proceeding without recording", error);
    }
  }

  private async recordMutations(
    name: string,
    device: BootedDevice,
    recorder: MutationRecorder,
    mutations: readonly ToolMutation[],
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const missing = await recorder.missingMutations(mutations);
    signal?.throwIfAborted();
    if (missing.length === 0) {
      signal?.throwIfAborted();
      return;
    }
    const priorValues = await this.readPriors(device, missing, signal);
    const recordedMutations = missing.map((mutation, index) => ({
      ...mutation,
      priorValue:
        mutation.kind === "opaque"
          ? { state: "unobservable" as const }
          : (priorValues[index] ?? { state: "unobservable" as const }),
      toolName: name,
    }));
    for (const mutation of recordedMutations) {
      signal?.throwIfAborted();
      if (mutation.kind === "installed-app") {
        mutation.priorValue = await recorder.baselinePrior(mutation.kind, mutation.key);
        signal?.throwIfAborted();
      }
      await recorder.record(mutation);
    }
    signal?.throwIfAborted();
  }

  private async readPriors(
    device: BootedDevice,
    mutations: readonly ToolMutation[],
    signal?: AbortSignal,
  ): Promise<readonly MutationValue[]> {
    try {
      return await runWithAbortSignal(signal, () => this.reader.read(device, mutations, signal));
    } catch (error) {
      logger.warn("Device mutation prior-value read failed; recording unobservable priors", error);
      signal?.throwIfAborted();
      return mutations.map(() => ({ state: "unobservable" }));
    }
  }
}
