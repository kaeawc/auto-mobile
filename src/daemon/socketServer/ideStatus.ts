import { createHash } from "node:crypto";
import {
  IOS_CTRL_PROXY_APP_HASH,
  resolveApkChecksum,
  resolveApkUrl,
  resolveAssetVersion,
  resolveIpaChecksum,
  resolveIpaUrl,
  resolvePinnedVersion,
} from "../../constants/release";
import { executionTracker } from "../../server/executionTracker";
import { isDebugModeEnabled } from "../../utils/debug";
import { processGenerationRecordFields } from "../processGenerationFields";
import type { DaemonSelfIdentity } from "../daemonHandshake";
import type { DaemonOptions } from "../types";

/** What `ide/status` reports about this daemon process, fixed when the socket server is built. */
export interface IdeStatusSource {
  daemonIdentity: DaemonSelfIdentity;
  identityStartedAt: number;
  identityProcessStartedAt?: number;
  identityDbPath?: string;
  identityPidFilePath?: string;
  identitySockets?: Record<string, string>;
  socketPath: string;
  startupOptions: DaemonOptions;
  processGenerationToken: string | undefined;
  acceptanceDiscoveryCapability: string | undefined;
}

/** The `ide/status` answer: daemon identity, capabilities and the pinned CtrlProxy assets. */
export function buildIdeStatus(source: IdeStatusSource) {
  const { daemonIdentity } = source;
  return {
    structuredSessionNotFound: true,
    structuredToolErrorCodes: true,
    // Concrete pinned version (honors AUTOMOBILE_VERSION), never the
    // floating "latest" tag — external consumers must see exactly what the
    // daemon will fetch (#2746).
    version: daemonIdentity.version,
    pid: process.pid,
    buildId: daemonIdentity.build.buildId,
    entryScript: daemonIdentity.build.entryScript,
    acceptanceCapabilityFingerprint: source.acceptanceDiscoveryCapability
      ? createHash("sha256").update(source.acceptanceDiscoveryCapability).digest("hex").slice(0, 8)
      : null,
    startedAt: source.identityStartedAt,
    processStartedAt: source.identityProcessStartedAt,
    dbPath: source.identityDbPath,
    reportedPidFilePath: source.identityPidFilePath,
    reportedSocketPath: source.socketPath,
    reportedSockets: source.identitySockets,
    effectiveDebug: isDebugModeEnabled(),
    options: source.startupOptions,
    ...processGenerationRecordFields(source.processGenerationToken),
    activeProvisioning: executionTracker.hasActiveToolExecution("provisionDevice", {
      scope: "global",
    }),
    releaseVersion: resolveAssetVersion(resolvePinnedVersion()),
    android: {
      ctrlProxy: {
        expectedSha256: resolveApkChecksum(),
        url: resolveApkUrl(),
      },
    },
    ios: {
      xcTestService: {
        expectedSha256: resolveIpaChecksum(),
        expectedAppHash: IOS_CTRL_PROXY_APP_HASH,
        url: resolveIpaUrl(),
      },
    },
  };
}
