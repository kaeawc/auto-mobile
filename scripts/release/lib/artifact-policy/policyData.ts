import { z } from "zod";

const exportedComponent = z.object({
  kind: z.enum(["activity", "activity-alias", "service", "receiver", "provider"]),
  name: z.string().min(1),
  /** When set, the component must be protected by exactly this permission. */
  permission: z.string().min(1).optional(),
});

const androidPolicy = z.object({
  applicationId: z.string().min(1),
  minTargetSdk: z.number().int().positive(),
  /** The merged manifest's `uses-permission*` set must equal this list. */
  permissions: z.array(z.string().min(1)),
  /** The merged manifest's own `<permission>` declarations must equal this list. */
  declaredPermissions: z.array(z.string().min(1)),
  /** The set of exported components must equal this list. */
  exportedComponents: z.array(exportedComponent),
});

const iosPolicy = z.object({
  bundleIdentifier: z.string().min(1),
  /** Entitlements outside this list fail; an unsigned or ad-hoc app carries none. */
  allowedEntitlements: z.array(z.string().min(1)),
  forbiddenEntitlements: z.array(z.string().min(1)),
  forbiddenInfoPlistKeys: z.array(z.string().min(1)),
  forbiddenSymbols: z.array(z.string().min(1)),
  privacyManifest: z.string().min(1),
});

const policySchema = z.object({
  description: z.string(),
  /** Rule id to the issue that must land before the rule can be enforced; reported as a warning. */
  advisory: z.record(z.string(), z.string()),
  android: androidPolicy,
  ios: iosPolicy,
});

export type ArtifactPolicy = z.infer<typeof policySchema>;
export type AndroidPolicy = z.infer<typeof androidPolicy>;
export type IosPolicy = z.infer<typeof iosPolicy>;

export function parseArtifactPolicy(json: string): ArtifactPolicy {
  return policySchema.parse(JSON.parse(json));
}

export interface PolicyFinding {
  /** Stable rule id, e.g. `android.allowBackup`; also the key into `advisory`. */
  readonly rule: string;
  readonly message: string;
}

export interface PolicyReport {
  readonly failures: readonly PolicyFinding[];
  /** Findings for rules still advisory, each with the issue that gates enforcement. */
  readonly warnings: readonly (PolicyFinding & { readonly pendingIssue: string })[];
}

/** Split findings into failures and warnings using the policy's advisory rule table. */
export function applyAdvisory(
  findings: readonly PolicyFinding[],
  advisory: Readonly<Record<string, string>>,
): PolicyReport {
  const failures: PolicyFinding[] = [];
  const warnings: (PolicyFinding & { pendingIssue: string })[] = [];
  for (const finding of findings) {
    const pendingIssue = advisory[finding.rule];
    if (pendingIssue === undefined) {
      failures.push(finding);
    } else {
      warnings.push({ ...finding, pendingIssue });
    }
  }
  return { failures, warnings };
}

export function formatReport(subject: string, report: PolicyReport): string {
  const lines = [
    ...report.failures.map((finding) => `FAIL [${finding.rule}] ${finding.message}`),
    ...report.warnings.map(
      (finding) =>
        `WARN [${finding.rule}] ${finding.message} (advisory until ${finding.pendingIssue})`,
    ),
  ];
  const verdict = report.failures.length === 0 ? "passed" : "FAILED";
  return [`ProtoViewer artifact policy ${verdict}: ${subject}`, ...lines].join("\n");
}
