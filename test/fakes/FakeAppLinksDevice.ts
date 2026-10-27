import type {
  AppLinkDomainSelector,
  AppLinksCommandOptions,
  AppLinksDevice,
  AppLinksTarget,
} from "../../src/features/utility/appLinks/AdbAppLinksDevice";
import type {
  AppLinkSettableState,
  AppLinksRead,
} from "../../src/features/utility/appLinks/appLinksOutput";

interface FakeUserState {
  linkHandlingAllowed: boolean;
  enabled: Set<string>;
}

export interface FakeAppLinksPackage {
  /** autoVerify domain -> state. */
  verification: Record<string, string>;
  /** Domains declared without autoVerify. */
  otherDomains?: string[];
  users?: Record<number, { linkHandlingAllowed?: boolean; enabled?: string[] }>;
}

/**
 * Stateful {@link AppLinksDevice} with AOSP `DomainVerificationShell` semantics:
 * `set-app-links` silently skips domains that are not autoVerify, and user
 * selection silently skips undeclared domains.
 */
export class FakeAppLinksDevice implements AppLinksDevice {
  readonly calls: string[] = [];
  private readonly packages = new Map<
    string,
    { verification: Map<string, string>; declared: string[]; users: Map<number, FakeUserState> }
  >();
  private failures = new Map<string, Error>();
  /** States `reverify` writes, as a verifier response would. */
  reverifyOutcome: Record<string, string> = {};

  install(packageName: string, pkg: FakeAppLinksPackage): this {
    const verification = new Map(Object.entries(pkg.verification));
    const users = new Map<number, FakeUserState>(
      Object.entries(pkg.users ?? { 0: {} }).map(([id, user]) => [
        Number(id),
        {
          linkHandlingAllowed: user.linkHandlingAllowed ?? true,
          enabled: new Set(user.enabled ?? []),
        },
      ]),
    );
    this.packages.set(packageName, {
      verification,
      declared: [...verification.keys(), ...(pkg.otherDomains ?? [])],
      users,
    });
    return this;
  }

  /** Make the next call of `method` reject with `error`. */
  failNext(
    method: "read" | "setVerificationState" | "setUserSelection" | "reverify",
    error: Error,
  ): void {
    this.failures.set(method, error);
  }

  state(packageName: string, domain: string): string | undefined {
    return this.packages.get(packageName)?.verification.get(domain);
  }

  enabled(packageName: string, userId: number): string[] {
    return [...(this.packages.get(packageName)?.users.get(userId)?.enabled ?? [])];
  }

  private consumeFailure(method: string): void {
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
  }

  async read(
    packageName: string,
    userId?: number,
    _options?: AppLinksCommandOptions,
  ): Promise<AppLinksRead> {
    this.calls.push(`read ${packageName} ${userId ?? "-"}`);
    this.consumeFailure("read");
    const pkg = this.packages.get(packageName);
    if (!pkg) {
      return { found: false, kind: "noState", reason: `${packageName} is not installed` };
    }
    const user = userId === undefined ? undefined : pkg.users.get(userId);
    return {
      found: true,
      snapshot: {
        verification: new Map(pkg.verification),
        ...(user && userId !== undefined
          ? {
              user: {
                userId,
                linkHandlingAllowed: user.linkHandlingAllowed,
                domains: [...pkg.declared],
                enabled: pkg.declared.filter((domain) => user.enabled.has(domain)),
              },
            }
          : {}),
      },
    };
  }

  async setVerificationState(
    packageName: string,
    state: AppLinkSettableState,
    domains: AppLinkDomainSelector,
    _options?: AppLinksCommandOptions,
  ): Promise<void> {
    this.calls.push(`set ${packageName} ${state} ${domains === "all" ? "all" : domains.join(",")}`);
    this.consumeFailure("setVerificationState");
    const pkg = this.packages.get(packageName);
    for (const domain of pkg?.verification.keys() ?? []) {
      if (domains === "all" || domains.includes(domain)) {
        pkg?.verification.set(domain, state);
      }
    }
  }

  async setUserSelection(
    packageName: string,
    userId: number,
    enabled: boolean,
    domains: AppLinkDomainSelector,
    _options?: AppLinksCommandOptions,
  ): Promise<void> {
    this.calls.push(
      `select ${packageName} ${userId} ${enabled} ${domains === "all" ? "all" : domains.join(",")}`,
    );
    this.consumeFailure("setUserSelection");
    const pkg = this.packages.get(packageName);
    const user = pkg?.users.get(userId);
    for (const domain of pkg?.declared ?? []) {
      if (user && (domains === "all" || domains.includes(domain))) {
        if (enabled) {
          user.enabled.add(domain);
        } else {
          user.enabled.delete(domain);
        }
      }
    }
  }

  async reverify(packageName: string, _options?: AppLinksCommandOptions): Promise<void> {
    this.calls.push(`reverify ${packageName}`);
    this.consumeFailure("reverify");
    const pkg = this.packages.get(packageName);
    for (const [domain, state] of Object.entries(this.reverifyOutcome)) {
      if (pkg?.verification.has(domain)) {
        pkg.verification.set(domain, state);
      }
    }
  }
}

export function fakeAppLinksTarget(
  appLinks: AppLinksDevice,
  options: { apiLevel?: number | null; currentUserId?: number } = {},
): AppLinksTarget {
  return {
    appLinks,
    apiLevel: async () => (options.apiLevel === undefined ? 34 : options.apiLevel),
    currentUserId: async () => options.currentUserId ?? 0,
  };
}
