import { collectAndroidArtifact, evaluateAndroidPolicy } from "./androidArtifactPolicy";
import {
  collectIosArtifact,
  evaluateIosPolicy,
  type IosBundleFiles,
  type IosPlatform,
} from "./iosArtifactPolicy";
import { applyAdvisory, type ArtifactPolicy, type PolicyReport } from "./policyData";
import type { ToolRunner } from "./toolRunner";

export interface AndroidGateRequest {
  readonly apkPath: string;
  readonly aapt2: string;
  readonly allowSnapshotVersion: boolean;
}

export interface IosGateRequest {
  readonly appPath: string;
  readonly platform: IosPlatform;
  readonly files: IosBundleFiles;
}

export async function runAndroidGate(
  request: AndroidGateRequest,
  policy: ArtifactPolicy,
  runner: ToolRunner,
): Promise<PolicyReport> {
  const artifact = await collectAndroidArtifact(request.apkPath, request.aapt2, runner);
  const findings = evaluateAndroidPolicy(artifact, policy.android, {
    allowSnapshotVersion: request.allowSnapshotVersion,
  });
  return applyAdvisory(findings, policy.advisory);
}

export async function runIosGate(
  request: IosGateRequest,
  policy: ArtifactPolicy,
  runner: ToolRunner,
): Promise<PolicyReport> {
  const artifact = await collectIosArtifact(request.appPath, runner, request.files);
  const findings = evaluateIosPolicy(artifact, policy.ios, { platform: request.platform });
  return applyAdvisory(findings, policy.advisory);
}
