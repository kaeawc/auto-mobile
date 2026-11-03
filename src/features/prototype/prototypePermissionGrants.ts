import { ActionableError } from "../../models/ActionableError";
import {
  notGrantableOnSimulator,
  PROTOTYPE_PERMISSION_MAP,
  type PrototypePermissionMapping,
  type PrototypePermissionName,
  type PrototypePermissionState,
} from "./prototypePermissionMap";

/**
 * How a prototype show sets declared permissions before launch (#14297). `prompt` leaves every
 * declared permission undetermined so the first `permissions.request` shows the system dialog;
 * `grantDeclared` grants all of them; `{grant, deny}` grants and denies the named ones and leaves
 * the rest undetermined.
 */
export type PrototypePermissionMode =
  | "prompt"
  | "grantDeclared"
  | { grant?: readonly string[]; deny?: readonly string[] };

/** Interactive shows prompt (owner decision on #14297); tests and agent loops pass a mode. */
export const DEFAULT_PROTOTYPE_PERMISSION_MODE: PrototypePermissionMode = "prompt";

export type PrototypePermissionStep = "grant" | "deny" | "leave";

/** Why a step could not be applied on this target, so `verified` is false. */
export type PrototypePermissionSkipReason = "notGrantableOnSimulator" | "notRevocable";

export interface PrototypePermissionResult {
  name: PrototypePermissionName;
  /** The state read back after the step ran. */
  state: PrototypePermissionState;
  /** Whether `state` is the one the step aims for. */
  verified: boolean;
  reason?: PrototypePermissionSkipReason;
}

/**
 * The per-device half of the grant: Android revokes with the `user-fixed` flag so a denial reads
 * `blocked` with no dialog, and an iOS simulator uses `simctl privacy grant|revoke`.
 */
export interface PrototypePermissionBackend {
  readonly target: "android" | "iosSimulator";
  grant(name: PrototypePermissionName, mapping: PrototypePermissionMapping): Promise<void>;
  deny(name: PrototypePermissionName, mapping: PrototypePermissionMapping): Promise<void>;
  read(
    name: PrototypePermissionName,
    mapping: PrototypePermissionMapping,
  ): Promise<PrototypePermissionState>;
}

/**
 * Resolves the mode against the spec's declared permissions, in declaration order. A grant or deny
 * of an undeclared name, or a name in both lists, is the caller's mistake and throws.
 */
export function planPrototypePermissions(
  declared: readonly PrototypePermissionName[],
  mode: PrototypePermissionMode,
): { name: PrototypePermissionName; step: PrototypePermissionStep }[] {
  if (mode === "prompt" || mode === "grantDeclared") {
    const step = mode === "prompt" ? "leave" : "grant";
    return declared.map((name) => ({ name, step }));
  }
  const grant = new Set(mode.grant ?? []);
  const deny = new Set(mode.deny ?? []);
  const undeclared = [...grant, ...deny].find(
    (name) => !declared.includes(name as PrototypePermissionName),
  );
  if (undeclared !== undefined) {
    throw new ActionableError(
      `Permission ${undeclared} is not declared in requires.permissions; declare it in the spec or drop it from the permissions mode`,
    );
  }
  const both = [...grant].find((name) => deny.has(name));
  if (both !== undefined) {
    throw new ActionableError(
      `Permission ${both} is in both grant and deny; list it in one of them`,
    );
  }
  return declared.map((name) => ({
    name,
    step: grant.has(name) ? "grant" : deny.has(name) ? "deny" : "leave",
  }));
}

/** What a step should leave the permission reading as on this target. */
function expectedState(
  step: PrototypePermissionStep,
  target: PrototypePermissionBackend["target"],
): PrototypePermissionState {
  if (step === "grant") {
    return "granted";
  }
  if (step === "deny") {
    return target === "android" ? "blocked" : "denied";
  }
  return "notDetermined";
}

function skipReason(
  name: PrototypePermissionName,
  step: PrototypePermissionStep,
  target: PrototypePermissionBackend["target"],
): PrototypePermissionSkipReason | undefined {
  if (step === "leave") {
    return undefined;
  }
  if (target === "iosSimulator") {
    return notGrantableOnSimulator(name) ? "notGrantableOnSimulator" : undefined;
  }
  // No runtime permission exists (photosAdd writes through MediaStore), so it cannot be denied.
  return step === "deny" && PROTOTYPE_PERMISSION_MAP[name].android.grant === "none"
    ? "notRevocable"
    : undefined;
}

/**
 * Runs the plan after install and before launch, so the first frame shows the final state, and
 * reports each declared permission as `{name, state, verified}`. Backend failures propagate: a
 * deterministic run must not launch on a half-applied plan.
 */
export async function applyPrototypePermissions(
  declared: readonly PrototypePermissionName[],
  mode: PrototypePermissionMode,
  backend: PrototypePermissionBackend,
): Promise<PrototypePermissionResult[]> {
  const results: PrototypePermissionResult[] = [];
  for (const { name, step } of planPrototypePermissions(declared, mode)) {
    const mapping = PROTOTYPE_PERMISSION_MAP[name];
    const reason = skipReason(name, step, backend.target);
    const noRuntimeGrant = backend.target === "android" && mapping.android.grant === "none";
    if (reason === undefined && step !== "leave" && !noRuntimeGrant) {
      await backend[step](name, mapping);
    }
    const state = await backend.read(name, mapping);
    results.push({
      name,
      state,
      verified: reason === undefined && state === expectedState(step, backend.target),
      ...(reason ? { reason } : {}),
    });
  }
  return results;
}
