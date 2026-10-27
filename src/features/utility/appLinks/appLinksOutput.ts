import type { AppLinkDomainState } from "../../../models";

/**
 * Parsing and state rules for Android's domain verification shell (#14110),
 * `pm get-app-links` / `set-app-links` / `set-app-links-user-selection`
 * (AOSP `DomainVerificationShell`, Android 12 / API 31 and newer).
 */

/** States `pm set-app-links <STATE>` accepts, by the name `pm get-app-links` prints. */
export const APP_LINK_SETTABLE_STATE_CODES = {
  none: 0,
  verified: 1,
  approved: 2,
  denied: 3,
} as const;

export type AppLinkSettableState = keyof typeof APP_LINK_SETTABLE_STATE_CODES;

/**
 * States Android treats as verified when it picks the app for a web link
 * (`DomainVerificationState.isVerified`): `approved` is a forced success.
 */
const VERIFIED_EQUIVALENT_STATES: ReadonlySet<string> = new Set([
  "verified",
  "approved",
  "migrated",
  "restored",
  "system_configured",
  "pre_verified",
]);

/** The minimum API level whose `pm` has the app-links commands. */
export const APP_LINKS_MIN_API_LEVEL = 31;

/** One user's link-handling settings from the `User <id>:` section. */
export interface AppLinksUserSelection {
  userId: number;
  /** "Verification link handling allowed"; absent when the line was not printed. */
  linkHandlingAllowed?: boolean;
  /** Every web domain the user section lists, enabled or not, in printed order. */
  domains: string[];
  /** Domains under `Enabled:`. */
  enabled: string[];
}

/** What one `pm get-app-links [--user <id>] <pkg>` read reported for the package. */
export interface AppLinksSnapshot {
  /** autoVerify domain -> state token as printed (`verified`, `none`, `1026`, ...). */
  verification: ReadonlyMap<string, string>;
  /** Present when the read named a user and the section was printed. */
  user?: AppLinksUserSelection;
}

export type AppLinksRead =
  | { found: true; snapshot: AppLinksSnapshot }
  | {
      found: false;
      /**
       * `unsupported`: pm has no app-links commands; `noState`: empty output (not installed, or
       * no web domains); `unreadable`: output without a block for the package.
       */
      kind: "unsupported" | "noState" | "unreadable";
      reason: string;
    };

const leadingWidth = (line: string): number => line.length - line.trimStart().length;

type Section = "none" | "verification" | "user";

interface ParseState {
  section: Section;
  /** The user-section list the next bare domain line belongs to. */
  list: "enabled" | "other" | null;
  verification: Map<string, string>;
  user?: AppLinksUserSelection;
}

const USER_HEADER = /^User (\d+):$/;
const DOMAIN_STATE = /^([^\s:]+):\s+(\S+)$/;
const LINK_HANDLING = /^Verification link handling allowed:\s*(true|false)$/i;

function parseUserLine(state: ParseState, text: string): void {
  const user = state.user;
  if (!user) {
    return;
  }
  const handling = LINK_HANDLING.exec(text);
  if (handling) {
    user.linkHandlingAllowed = handling[1].toLowerCase() === "true";
    state.list = null;
    return;
  }
  if (text === "Selection state:") {
    state.list = null;
    return;
  }
  if (text.endsWith(":")) {
    // `Enabled:` / `Disabled:` (any other list name counts as not enabled).
    state.list = text === "Enabled:" ? "enabled" : "other";
    return;
  }
  if (state.list && !text.includes(" ")) {
    user.domains.push(text);
    if (state.list === "enabled") {
      user.enabled.push(text);
    }
  }
}

function parseBlockLine(state: ParseState, text: string): void {
  if (text === "Domain verification state:") {
    state.section = "verification";
    return;
  }
  const userHeader = USER_HEADER.exec(text);
  if (userHeader) {
    state.section = "user";
    state.list = null;
    state.user = {
      userId: Number.parseInt(userHeader[1], 10),
      domains: [],
      enabled: [],
    };
    return;
  }
  if (state.section === "verification") {
    const match = DOMAIN_STATE.exec(text);
    if (match) {
      state.verification.set(match[1], match[2]);
      return;
    }
    state.section = "none";
    return;
  }
  if (state.section === "user") {
    parseUserLine(state, text);
  }
}

/**
 * Parse `pm get-app-links [--user <id>] <packageName>` output. The package's
 * block starts at the line `<packageName>:` (at any indentation; some builds
 * print a `Domain verification status:` header first) and ends at the next
 * line indented no deeper. Sections are recognised by their labels, not by
 * exact indentation, so the API 31-35 layout differences parse the same way.
 * Returns null when the package has no block (not installed, or no web domains).
 */
export function parseAppLinksOutput(output: string, packageName: string): AppLinksSnapshot | null {
  const lines = output.replace(/\r/g, "").replace(/\t/g, "    ").split("\n");
  const headerIndex = lines.findIndex((line) => line.trim() === `${packageName}:`);
  if (headerIndex < 0) {
    return null;
  }
  const headerWidth = leadingWidth(lines[headerIndex]);
  const state: ParseState = { section: "none", list: null, verification: new Map() };
  for (const line of lines.slice(headerIndex + 1)) {
    const text = line.trim();
    if (text.length === 0) {
      continue;
    }
    if (leadingWidth(line) <= headerWidth) {
      break;
    }
    parseBlockLine(state, text);
  }
  return state.user
    ? { verification: state.verification, user: state.user }
    : { verification: state.verification };
}

/** Lines `pm` prints instead of state when the command or package is unknown. */
export function appLinksOutputReportsUnsupported(output: string): boolean {
  return /Unknown command|Unknown option/i.test(output);
}

export function isVerifiedEquivalentState(state: string | undefined): boolean {
  return state !== undefined && VERIFIED_EQUIVALENT_STATES.has(state);
}

/**
 * How a recorded state is written back with `pm set-app-links`. Only `none`,
 * `verified`, `approved` and `denied` can be set from the shell. Another
 * verified-equivalent state (`migrated`, `restored`, `system_configured`,
 * `pre_verified`) is restored as `verified`, which opens links the same way but
 * lets the verifier overwrite it. A failure the verifier recorded
 * (`legacy_failure`, a numeric error code) is restored as `none`: unverified, but
 * the verifier may retry it.
 */
export function appLinkRestoreTarget(original: string): {
  state: AppLinkSettableState;
  exact: boolean;
} {
  if (Object.hasOwn(APP_LINK_SETTABLE_STATE_CODES, original)) {
    return { state: original as AppLinkSettableState, exact: true };
  }
  return isVerifiedEquivalentState(original)
    ? { state: "verified", exact: false }
    : { state: "none", exact: false };
}

/** Every domain the snapshot names: autoVerify domains first, then user-only ones. */
export function appLinkDomains(snapshot: AppLinksSnapshot): string[] {
  const domains = [...snapshot.verification.keys()];
  const seen = new Set(domains);
  for (const domain of snapshot.user?.domains ?? []) {
    if (!seen.has(domain)) {
      seen.add(domain);
      domains.push(domain);
    }
  }
  return domains;
}

/** The public per-domain view of a snapshot. */
export function toAppLinkDomainStates(snapshot: AppLinksSnapshot): AppLinkDomainState[] {
  const enabled = new Set(snapshot.user?.enabled ?? []);
  const handlingAllowed = snapshot.user?.linkHandlingAllowed !== false;
  return appLinkDomains(snapshot).map((domain) => {
    const state = snapshot.verification.get(domain);
    const userSelected = enabled.has(domain);
    return {
      domain,
      ...(state === undefined ? {} : { state }),
      autoVerify: state !== undefined,
      userSelected,
      approvedForLinks: handlingAllowed && (isVerifiedEquivalentState(state) || userSelected),
    };
  });
}
