import { parseTeamIdentifier } from "../../utils/ios-cmdline-tools/CtrlProxyCodesignVerifier";
import {
  NETWORK_FILTER_APP_IDENTIFIER,
  NETWORK_FILTER_PROVIDER_IDENTIFIER,
  providerPath,
} from "./networkFilterApp";
import {
  DefaultNetworkFilterCommandRunner,
  type NetworkFilterCommandRunner,
} from "./networkFilterHost";

/** Signing identity of one bundle as reported by `codesign -dvvv`. */
export interface CodeSigningIdentity {
  identifier: string | null;
  teamIdentifier: string | null;
  cdhash: string | null;
}

export interface NetworkFilterSignatureInspection {
  /** `codesign --verify --deep --strict <app>` exited 0. */
  verified: boolean;
  /** codesign's own explanation when verification failed. */
  verifyDetail: string;
  app: CodeSigningIdentity;
  provider: CodeSigningIdentity;
}

/**
 * Narrow seam over `codesign` for the Network Extension app (#10588). The
 * installer applies the policy ({@link signatureProblems}); this only inspects.
 */
export interface CodeSignVerifier {
  inspect(appPath: string): Promise<NetworkFilterSignatureInspection>;
}

const CODESIGN_TIMEOUT_MS = 30_000;

function parseDisplayField(output: string, key: string): string | null {
  const prefix = `${key}=`;
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value && value.length > 0 ? value : null;
}

export class DefaultCodeSignVerifier implements CodeSignVerifier {
  constructor(
    private readonly runner: NetworkFilterCommandRunner = new DefaultNetworkFilterCommandRunner(),
  ) {}

  async inspect(appPath: string): Promise<NetworkFilterSignatureInspection> {
    const verify = await this.runner.run("codesign", ["--verify", "--deep", "--strict", appPath], {
      timeoutMs: CODESIGN_TIMEOUT_MS,
    });
    return {
      verified: verify.exitCode === 0,
      verifyDetail: verify.stderr.trim(),
      app: await this.identity(appPath),
      provider: await this.identity(providerPath(appPath)),
    };
  }

  private async identity(bundlePath: string): Promise<CodeSigningIdentity> {
    const display = await this.runner.run("codesign", ["-dvvv", bundlePath], {
      timeoutMs: CODESIGN_TIMEOUT_MS,
    });
    // `codesign -d` prints its key=value dump to stderr.
    const output = `${display.stderr}\n${display.stdout}`;
    return {
      identifier: parseDisplayField(output, "Identifier"),
      teamIdentifier: parseTeamIdentifier(output),
      cdhash: parseDisplayField(output, "CDHash"),
    };
  }
}

const TEAM_ID_FORMAT = /^[A-Z0-9]{10}$/;

/**
 * Policy for a candidate or installed app: an intact deep signature, the
 * expected bundle identifiers, and one Developer ID team shared by the app and
 * its provider (the provider's XPC only accepts same-team peers). When a team
 * is pinned it must match exactly. An empty list means the app is acceptable.
 */
export function signatureProblems(
  inspection: NetworkFilterSignatureInspection,
  pinnedTeamId: string | null,
): string[] {
  return [
    integrityProblem(inspection),
    identifierProblem("app", inspection.app.identifier, NETWORK_FILTER_APP_IDENTIFIER),
    identifierProblem(
      "provider",
      inspection.provider.identifier,
      NETWORK_FILTER_PROVIDER_IDENTIFIER,
    ),
    teamProblem(inspection),
    pinnedTeamProblem(inspection.app.teamIdentifier, pinnedTeamId),
  ].filter((problem): problem is string => problem !== null);
}

function integrityProblem(inspection: NetworkFilterSignatureInspection): string | null {
  if (inspection.verified) {
    return null;
  }
  const detail = inspection.verifyDetail ? `: ${inspection.verifyDetail}` : "";
  return `codesign --verify --deep --strict failed${detail}`;
}

function identifierProblem(
  component: "app" | "provider",
  actual: string | null,
  expected: string,
): string | null {
  return actual === expected
    ? null
    : `${component} identifier is ${actual ?? "missing"}, expected ${expected}`;
}

function teamProblem(inspection: NetworkFilterSignatureInspection): string | null {
  const team = inspection.app.teamIdentifier;
  if (team === null || !TEAM_ID_FORMAT.test(team)) {
    return `app is not signed by a Developer ID team (TeamIdentifier ${team ?? "not set"})`;
  }
  const providerTeam = inspection.provider.teamIdentifier;
  return providerTeam === team
    ? null
    : `provider team ${providerTeam ?? "not set"} differs from app team ${team}`;
}

function pinnedTeamProblem(team: string | null, pinnedTeamId: string | null): string | null {
  if (!pinnedTeamId || team === pinnedTeamId) {
    return null;
  }
  return `signing team ${team ?? "not set"} does not match the pinned team ${pinnedTeamId}`;
}
