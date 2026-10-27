import {
  type AppFileProviderWriteResult,
  type AppFileWriteProvider,
  type PutAppFileProviderRequest,
} from "./appFileService";
import { ActionableError, BootedDevice } from "../models";
import {
  PutAppFileTarget,
  UserFilesTarget,
  normalizeAppFileRelativePath,
  normalizeUserFilesNamespace,
} from "./appFileContract";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";
import { win32 } from "node:path";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";

/** The managed fixture app; `IosFilesFixtureInstaller` builds and installs it on first use. */
export const IOS_FILES_FIXTURE_BUNDLE_ID = "dev.jasonpearson.automobile.FilesFixture";

/** Host staging only; completion makes no assertion about document-picker visibility. */
export interface IosFilesFixtureContainer {
  /** Resolves with `providerInstalled` when this call had to install the fixture app first. */
  stageFiles(
    requests: readonly PutAppFileProviderRequest[],
  ): Promise<void | { providerInstalled?: boolean }>;
}

export interface DocumentPickerVisibilityVerifier {
  verify(request: {
    device: BootedDevice;
    namespace: string;
    destinationPath: string;
    signal?: AbortSignal;
  }): Promise<{ status: "completed" | "unavailable"; reason?: string }>;
}

const unverifiedDocumentPicker: DocumentPickerVisibilityVerifier = {
  verify: async () => ({
    status: "unavailable",
    reason:
      "Picker visibility is unavailable: no document-picker verifier observed the destination.",
  }),
};

export function validateIosFilesDeviceTarget(device: BootedDevice, target: PutAppFileTarget): void {
  if (device.platform === "ios" && target.domain === "user_files") {
    requireIosFilesSimulator(device);
  }
}

export function requireIosFilesSimulator(device: BootedDevice): void {
  if (resolveIosDeviceKind({ deviceId: device.deviceId }) !== "simulator") {
    throw new ActionableError(
      `iOS user_files staging is only supported on iOS Simulators. Device ${device.deviceId} looks like a physical iOS device. ` +
        "Physical iOS is unsupported without an on-device fixture-app integration.",
    );
  }
}

export function normalizeIosFilesRequest(
  request: PutAppFileProviderRequest,
): PutAppFileProviderRequest & { target: UserFilesTarget } {
  requireIosFilesSimulator(request.device);
  if (request.target.domain !== "user_files") {
    throw new ActionableError("iOS Files fixture provider requires target.domain user_files.");
  }
  if (win32.isAbsolute(request.destinationPath) || /^[A-Za-z]:/.test(request.destinationPath)) {
    throw new ActionableError(
      "iOS Files destinationPath must be relative, without an absolute path or drive-letter prefix.",
    );
  }
  return {
    ...request,
    target: { ...request.target, namespace: normalizeUserFilesNamespace(request.target.namespace) },
    destinationPath: normalizeAppFileRelativePath(request.destinationPath),
  };
}

export class IosSimulatorUserFilesProvider implements AppFileWriteProvider {
  readonly platform = "ios" as const;
  readonly domain = "user_files" as const;
  readonly features = { namespaceReset: true } as const;

  constructor(
    private readonly container: IosFilesFixtureContainer,
    private readonly verifier: DocumentPickerVisibilityVerifier = unverifiedDocumentPicker,
  ) {}

  async putFile(request: PutAppFileProviderRequest): Promise<AppFileProviderWriteResult> {
    return (await this.putFiles([request]))[0]!;
  }

  async putFiles(requests: PutAppFileProviderRequest[]): Promise<AppFileProviderWriteResult[]> {
    const normalized = requests.map(normalizeIosFilesRequest);
    const staged = await this.container.stageFiles(normalized);
    const providerInstalled = staged?.providerInstalled === true;
    const results: AppFileProviderWriteResult[] = [];
    for (const request of normalized) {
      let visibility: Awaited<ReturnType<DocumentPickerVisibilityVerifier["verify"]>>;
      try {
        visibility = await this.verifier.verify({
          device: request.device,
          namespace: request.target.namespace,
          destinationPath: request.destinationPath,
          signal: request.signal,
        });
      } catch (error) {
        logger.warn(
          `Failed to verify iOS document picker visibility: ${errorMessage(error)}`,
          error,
        );
        visibility = {
          status: "unavailable",
          reason: `Document-picker verification failed: ${errorMessage(error)}`,
        };
      }
      results.push({
        effects: [
          ...(providerInstalled && results.length === 0
            ? [{ type: "provider_install" as const, status: "completed" as const }]
            : []),
          { type: "host_stage", status: "completed" },
          { type: "document_picker", ...visibility },
        ],
      });
    }
    return results;
  }
}
