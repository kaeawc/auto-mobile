import type { AppLinkDomainState, BootedDevice } from "../../../models";
import { ActionableError } from "../../../models/ActionableError";
import { throwIfAborted } from "../../../utils/toolUtils";
import type { AppLinksTarget } from "./AdbAppLinksDevice";
import {
  APP_LINKS_MIN_API_LEVEL,
  appLinkDomains,
  appLinkRestoreTarget,
  toAppLinkDomainStates,
  type AppLinkSettableState,
  type AppLinksSnapshot,
} from "./appLinksOutput";
import {
  applyAppLinksRestorePlan,
  appLinksRestorePlanIsEmpty,
  planAppLinksRestore,
  readAppLinksRestoreBaseline,
  type AppLinksRecordScope,
  type AppLinksRestoreEntry,
  type AppLinksRestoreRegistry,
} from "./AppLinkRestore";

export const SET_APP_LINKS_ACTIONS = [
  "approve",
  "reset",
  "reverify",
  "userSelection",
  "restore",
] as const;

export type SetAppLinksAction = (typeof SET_APP_LINKS_ACTIONS)[number];

type ChangeAction = Exclude<SetAppLinksAction, "restore">;

export interface SetAppLinksRequest {
  appId: string;
  userId?: number;
  action: SetAppLinksAction;
  /** approve / reset / userSelection: the domains to change; omitted means every domain. */
  domains?: readonly string[];
  /** userSelection: enable (true) or disable (false) the domains. */
  enabled?: boolean;
}

export interface SetAppLinksDependencies {
  target: AppLinksTarget;
  registry: AppLinksRestoreRegistry;
  /** The session that owns the change; its release restores it. */
  owner?: string;
  signal?: AbortSignal;
}

export interface AppLinkChange {
  domain: string;
  before: { state?: string; userSelected: boolean };
  after: { state?: string; userSelected: boolean };
}

export interface AppLinksRestoreReceipt {
  /** A session release (or rebind) writes this back automatically. */
  onSessionRelease: boolean;
  verification?: {
    domain: string;
    original: string;
    restoreAs: AppLinkSettableState;
    /** False when the shell cannot set `original`; `restoreAs` is the closest settable state. */
    exact: boolean;
  }[];
  userSelections?: { userId: number; enabled: string[] }[];
}

export interface SetAppLinksResult {
  appId: string;
  userId: number;
  action: SetAppLinksAction;
  changed: AppLinkChange[];
  /** Requested domains whose state did not take (pm reports no per-domain failure). */
  unapplied?: string[];
  appLinks: AppLinkDomainState[];
  appLinkHandlingAllowed?: boolean;
  /** Present while a recorded original state remains to restore. */
  restore?: AppLinksRestoreReceipt;
  note?: string;
}

const RECORD_SCOPE: Record<ChangeAction, (userId: number) => AppLinksRecordScope> = {
  approve: () => ({ verification: true }),
  reset: () => ({ verification: true }),
  reverify: () => ({ verification: true }),
  userSelection: (userId) => ({ verification: false, userId }),
};

function validateArguments(request: SetAppLinksRequest): void {
  const takesDomains = ["approve", "reset", "userSelection"].includes(request.action);
  if (request.domains !== undefined && !takesDomains) {
    throw new ActionableError(`setAppLinks action "${request.action}" does not take domains.`);
  }
  if (request.domains !== undefined && request.domains.length === 0) {
    throw new ActionableError("setAppLinks domains must be non-empty; omit it for every domain.");
  }
  if (request.action === "userSelection" && request.enabled === undefined) {
    throw new ActionableError(
      'setAppLinks action "userSelection" requires enabled: true or false.',
    );
  }
  if (request.action !== "userSelection" && request.enabled !== undefined) {
    throw new ActionableError('setAppLinks enabled applies only to action "userSelection".');
  }
}

function validateDomains(request: SetAppLinksRequest, snapshot: AppLinksSnapshot): void {
  if (!request.domains) {
    return;
  }
  const verifiable = [...snapshot.verification.keys()];
  const declared = appLinkDomains(snapshot);
  const allowed = request.action === "userSelection" ? declared : verifiable;
  const unknown = request.domains.filter((domain) => !allowed.includes(domain));
  if (unknown.length === 0) {
    return;
  }
  const hint =
    request.action === "userSelection"
      ? `Declared domains: ${declared.join(", ") || "none"}.`
      : `Only autoVerify domains have a verification state: ${verifiable.join(", ") || "none"}. ` +
        'Use action "userSelection" for the others.';
  throw new ActionableError(
    `${request.appId} does not declare ${unknown.join(", ")} for ${request.action}. ${hint}`,
  );
}

async function readSnapshot(
  target: AppLinksTarget,
  appId: string,
  userId: number,
  signal: AbortSignal | undefined,
): Promise<AppLinksSnapshot> {
  const read = await target.appLinks.read(appId, userId, { signal });
  throwIfAborted(signal);
  if (!read.found) {
    throw new ActionableError(read.reason);
  }
  return read.snapshot;
}

function diffDomains(before: AppLinksSnapshot, after: AppLinksSnapshot): AppLinkChange[] {
  const beforeStates = new Map(toAppLinkDomainStates(before).map((d) => [d.domain, d]));
  return toAppLinkDomainStates(after).flatMap((now) => {
    const was = beforeStates.get(now.domain);
    if (was && was.state === now.state && was.userSelected === now.userSelected) {
      return [];
    }
    return [
      {
        domain: now.domain,
        before: { state: was?.state, userSelected: was?.userSelected ?? false },
        after: { state: now.state, userSelected: now.userSelected },
      },
    ];
  });
}

function unappliedDomains(request: SetAppLinksRequest, after: AppLinksSnapshot): string[] {
  const states = toAppLinkDomainStates(after);
  const requested = request.domains ? new Set(request.domains) : undefined;
  const inScope = (domain: AppLinkDomainState): boolean =>
    requested ? requested.has(domain.domain) : true;
  switch (request.action) {
    case "approve":
      return states
        .filter((d) => d.autoVerify && inScope(d) && d.state !== "approved")
        .map((d) => d.domain);
    case "reset":
      return states
        .filter((d) => d.autoVerify && inScope(d) && d.state !== "none")
        .map((d) => d.domain);
    case "userSelection":
      return states
        .filter((d) => inScope(d) && d.userSelected !== request.enabled)
        .map((d) => d.domain);
    default:
      return [];
  }
}

/** The receipt for a recorded entry, or undefined when nothing is recorded. */
export function appLinksRestoreReceipt(
  entry: AppLinksRestoreEntry | undefined,
): AppLinksRestoreReceipt | undefined {
  if (!entry) {
    return undefined;
  }
  const verification = entry.verification
    ? [...entry.verification].map(([domain, original]) => {
        const target = appLinkRestoreTarget(original);
        return { domain, original, restoreAs: target.state, exact: target.exact };
      })
    : undefined;
  const userSelections = [...entry.selections].map(([userId, enabled]) => ({
    userId,
    enabled: [...enabled],
  }));
  return {
    onSessionRelease: entry.owner !== undefined,
    ...(verification ? { verification } : {}),
    ...(userSelections.length > 0 ? { userSelections } : {}),
  };
}

function runChange(
  action: ChangeAction,
  request: SetAppLinksRequest,
  userId: number,
  deps: SetAppLinksDependencies,
): Promise<void> {
  const { appLinks } = deps.target;
  const options = { signal: deps.signal };
  const domains = request.domains ?? "all";
  switch (action) {
    case "approve":
      return appLinks.setVerificationState(request.appId, "approved", domains, options);
    case "reset":
      return appLinks.setVerificationState(request.appId, "none", domains, options);
    case "reverify":
      return appLinks.reverify(request.appId, options);
    case "userSelection":
      return appLinks.setUserSelection(
        request.appId,
        userId,
        request.enabled === true,
        domains,
        options,
      );
  }
}

/**
 * Write back what the registry recorded for this package on this device, and
 * forget it only once every write landed, so a failed restore can be retried
 * (and is still restored on session release).
 */
async function restoreRecorded(
  device: BootedDevice,
  appId: string,
  deps: SetAppLinksDependencies,
): Promise<void> {
  const entry = deps.registry.get(device.deviceId, appId);
  if (!entry) {
    return;
  }
  const options = { signal: deps.signal };
  const baseline = await readAppLinksRestoreBaseline(deps.target.appLinks, entry, options);
  const plan = planAppLinksRestore(entry, baseline);
  await applyAppLinksRestorePlan(deps.target.appLinks, entry.packageName, plan, options);
  if (deps.registry.get(device.deviceId, appId) === entry) {
    deps.registry.take(device.deviceId, appId);
  }
}

function actionNote(
  request: SetAppLinksRequest,
  after: AppLinksSnapshot,
  hadRecord: boolean,
): string | undefined {
  if (request.action === "reverify") {
    return "Verification runs asynchronously; states can stay unchanged until the verifier responds. Read them again with getDeepLinks.";
  }
  if (request.action === "restore" && !hadRecord) {
    return "Nothing recorded to restore: setAppLinks has not changed this package on this device.";
  }
  if (after.user?.linkHandlingAllowed === false && request.action !== "restore") {
    return 'Link handling is turned off for this app ("Open supported links"), so links still do not open it directly.';
  }
  return undefined;
}

async function assertAppLinksSupported(
  device: BootedDevice,
  target: AppLinksTarget,
  signal: AbortSignal | undefined,
): Promise<void> {
  const apiLevel = await target.apiLevel(signal);
  throwIfAborted(signal);
  if (apiLevel !== null && apiLevel < APP_LINKS_MIN_API_LEVEL) {
    throw new ActionableError(
      `setAppLinks needs Android 12 (API ${APP_LINKS_MIN_API_LEVEL}) or newer; ${device.deviceId} runs API ${apiLevel}.`,
    );
  }
}

/** Drop the record once the state is back at it: nothing is left for release to restore. */
function forgetSettledRecord(
  registry: AppLinksRestoreRegistry,
  device: BootedDevice,
  appId: string,
  userId: number,
  after: AppLinksSnapshot,
): void {
  const entry = registry.get(device.deviceId, appId);
  if (!entry) {
    return;
  }
  const remaining = planAppLinksRestore(entry, {
    verification: after.verification,
    users: new Map([[userId, after]]),
  });
  // Another user's recorded selection was not read back here, so it may still differ.
  const onlyThisUser = [...entry.selections.keys()].every((id) => id === userId);
  if (appLinksRestorePlanIsEmpty(remaining) && onlyThisUser) {
    registry.take(device.deviceId, appId);
  }
}

/**
 * Change an Android app's App Links state (#14110) and report what changed.
 * The state before the first change is recorded write-once per device and
 * package; `action: "restore"` (or the owning session's release) writes it back.
 */
export async function setAppLinks(
  device: BootedDevice,
  request: SetAppLinksRequest,
  deps: SetAppLinksDependencies,
): Promise<SetAppLinksResult> {
  validateArguments(request);
  const { target, registry, signal } = deps;
  await assertAppLinksSupported(device, target, signal);
  const userId = request.userId ?? (await target.currentUserId(signal));
  const before = await readSnapshot(target, request.appId, userId, signal);
  validateDomains(request, before);

  const hadRecord = registry.get(device.deviceId, request.appId) !== undefined;
  if (request.action === "restore") {
    await restoreRecorded(device, request.appId, deps);
  } else {
    const scope = RECORD_SCOPE[request.action](userId);
    registry.record(device, request.appId, before, scope, deps.owner);
    await runChange(request.action, request, userId, deps);
  }

  const after = await readSnapshot(target, request.appId, userId, signal);
  forgetSettledRecord(registry, device, request.appId, userId, after);
  const unapplied = unappliedDomains(request, after);
  const note = actionNote(request, after, hadRecord);
  const receipt = appLinksRestoreReceipt(registry.get(device.deviceId, request.appId));
  const handling = after.user?.linkHandlingAllowed;
  return {
    appId: request.appId,
    userId,
    action: request.action,
    changed: diffDomains(before, after),
    ...(unapplied.length > 0 ? { unapplied } : {}),
    appLinks: toAppLinkDomainStates(after),
    ...(handling === undefined ? {} : { appLinkHandlingAllowed: handling }),
    ...(receipt ? { restore: receipt } : {}),
    ...(note ? { note } : {}),
  };
}
