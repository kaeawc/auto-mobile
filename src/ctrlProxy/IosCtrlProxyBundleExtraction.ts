import * as fs from "fs/promises";
import * as path from "path";
import { resolveAssetVersion, resolvePinnedVersion } from "../constants/release";
import { ensureSecureDir } from "../utils/filesystem/securePermissions";
import type { CtrlProxyIosBundleDownloader } from "../utils/IOSCtrlProxyBundleDownloader";
import type {
  IosRunnerArtifactVerifier,
  IOSCtrlProxyBundleMetadata,
} from "./IosRunnerArtifactVerifier";

interface BundleExtractionDependencies {
  derivedDataPath: string;
  downloader: Pick<CtrlProxyIosBundleDownloader, "extractBundle">;
  artifactVerifier: Pick<
    IosRunnerArtifactVerifier,
    | "clearLocalRunnerPins"
    | "assertDerivedDataDirOwnedByCurrentUid"
    | "getMetadataPath"
    | "verifyExtractedArtifacts"
    | "computeAppHashes"
    | "getExpectedChecksum"
  >;
  normalizeExtractedBundle: () => Promise<void>;
}

/** Caller must hold the builder's derived-data lock throughout extraction. */
export async function extractIosCtrlProxyBundle(
  bundlePath: string,
  localOverridePath: string | null,
  {
    derivedDataPath,
    downloader,
    artifactVerifier,
    normalizeExtractedBundle,
  }: BundleExtractionDependencies,
): Promise<void> {
  // A re-extract replaces the runner binary, so drop any local-build-mode pin
  // (#5561) BEFORE re-extraction — the post-extract verify a few lines down
  // re-derives it. Clearing here (not after extract) is essential: the pin is
  // set inside verifyExtractedArtifacts() below, so clearing post-extract would
  // erase the fresh pin and make the next pre-launch wrongly store-and-trust.
  artifactVerifier.clearLocalRunnerPins();
  // Fail closed before wiping/repopulating the tree if it is owned by another
  // uid — extracting into a directory we do not own reopens the TOCTOU window
  // this hardening closes (issue #4759).
  await artifactVerifier.assertDerivedDataDirOwnedByCurrentUid();
  // The extracted tree is about to be replaced. A later failure must not leave
  // the previous release's metadata describing a different runner on disk.
  await fs.rm(artifactVerifier.getMetadataPath(), { force: true });
  await downloader.extractBundle(bundlePath, derivedDataPath);
  // Authoritatively restrict the extraction tree to owner-only (0o700),
  // independent of the downloader implementation: the runner is launched from
  // here, so other uids must not be able to read or swap its binaries (#4759).
  await ensureSecureDir(derivedDataPath);
  await normalizeExtractedBundle();
  await artifactVerifier.verifyExtractedArtifacts();

  const appHashes = await artifactVerifier.computeAppHashes();
  const checksum = artifactVerifier.getExpectedChecksum();
  const metadata: IOSCtrlProxyBundleMetadata = {
    checksum: checksum || null,
    version: localOverridePath
      ? checksum
        ? `local-override:${checksum.slice(0, 12)}`
        : `local-override:${path.basename(localOverridePath)}`
      : resolveAssetVersion(resolvePinnedVersion()),
    extractedAt: new Date().toISOString(),
    appHashes,
  };
  await fs.writeFile(
    artifactVerifier.getMetadataPath(),
    JSON.stringify(metadata, null, 2),
    "utf-8",
  );
}
