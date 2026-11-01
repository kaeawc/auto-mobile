import { z } from "zod/v4";
import { ToolRegistry, type ProgressCallback } from "./toolRegistry";
import { setAppLinksResultSchema } from "./deepLinkToolOutputSchemas";
import { runSessionAppLinksMutation, type SessionAppLinksHost } from "./sessionAppLinks";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { defaultDaemonContext } from "../daemon/daemonContext";
import type { BootedDevice } from "../models";
import { ActionableError } from "../models/ActionableError";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { addDeviceTargetingToSchema, withAppIdAliases } from "../utils/schemaHelpers";
import {
  createAdbAppLinksTarget,
  type AppLinksTarget,
} from "../features/utility/appLinks/AdbAppLinksDevice";
import {
  defaultAppLinksRestoreRegistry,
  type AppLinksRestoreRegistry,
} from "../features/utility/appLinks/AppLinkRestore";
import {
  SET_APP_LINKS_ACTIONS,
  setAppLinks,
  type SetAppLinksResult,
} from "../features/utility/appLinks/SetAppLinks";

/** A web domain as Android declares it, optionally with a leading `*.` wildcard. */
const APP_LINK_DOMAIN = /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;

export const setAppLinksSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string().min(1).describe("Android package name."),
        userId: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Android user for userSelection and the read-back; defaults to the current user.",
          ),
        action: z
          .enum(SET_APP_LINKS_ACTIONS)
          .describe(
            "approve: force-approve autoVerify domains (pm set-app-links 2), leaving already-verified domains in non-settable states (system_configured, pre_verified, migrated, restored) untouched. reset: clear verification " +
              "to none (pm set-app-links 0). reverify: ask the verifier again (asynchronous). " +
              "userSelection: enable or disable domains for the user. restore: write back the state " +
              "recorded before the first setAppLinks change, using the closest settable state when exact restoration is unavailable.",
          ),
        domains: z
          .array(z.string().regex(APP_LINK_DOMAIN, "Expected a host name such as example.com"))
          .min(1)
          .optional()
          .describe(
            "approve, reset, userSelection: domains to change; omit for every declared domain.",
          ),
        enabled: z
          .boolean()
          .optional()
          .describe(
            "userSelection only: true enables the domains for the user, false disables them.",
          ),
      })
      .strict(),
  ),
);

export type SetAppLinksArgs = z.output<typeof setAppLinksSchema>;

export type AppLinksTargetFactory = (device: BootedDevice) => AppLinksTarget;

const defaultAppLinksTargetFactory: AppLinksTargetFactory = (device) =>
  createAdbAppLinksTarget(defaultAdbClientFactory.create(device));

export interface SetAppLinksToolDependencies {
  sessionManager?: () => SessionAppLinksHost | undefined;
  targetFor?: AppLinksTargetFactory;
  registry?: AppLinksRestoreRegistry;
}

function describeResult(result: SetAppLinksResult): string {
  const changed = result.changed.length;
  const summary =
    changed === 0
      ? `setAppLinks ${result.action}: no domain changed for ${result.appId}`
      : `setAppLinks ${result.action}: ${changed} domain${changed === 1 ? "" : "s"} changed for ${result.appId}`;
  return result.unapplied ? `${summary}; not applied: ${result.unapplied.join(", ")}` : summary;
}

export const createSetAppLinksHandler =
  (deps: SetAppLinksToolDependencies = {}) =>
  async (
    device: BootedDevice,
    args: SetAppLinksArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    if (device.platform !== "android") {
      throw new ActionableError(
        "setAppLinks supports Android 12+ only; iOS universal links have no shell verification control.",
      );
    }
    const sessionManager = args.sessionUuid
      ? (deps.sessionManager ?? (() => defaultDaemonContext.sessionManager()))()
      : undefined;
    const target = (deps.targetFor ?? defaultAppLinksTargetFactory)(device);
    const result = await runSessionAppLinksMutation(
      sessionManager,
      args.sessionUuid,
      device.deviceId,
      (owner) =>
        setAppLinks(
          device,
          {
            appId: args.appId,
            userId: args.userId,
            action: args.action,
            domains: args.domains,
            enabled: args.enabled,
          },
          {
            target,
            registry: deps.registry ?? defaultAppLinksRestoreRegistry,
            owner,
            signal,
          },
        ),
    );
    return createStructuredToolResponse({
      message: describeResult(result),
      success: true,
      ...result,
    });
  };

const SET_APP_LINKS_DESCRIPTION =
  "Android 12+: change an app's App Links state so https links open the app directly (or not). " +
  "approve force-verifies autoVerify domains, leaving already-verified domains in non-settable states (system_configured, pre_verified, migrated, restored) untouched; reset clears them to none, reverify re-runs " +
  "verification, userSelection enables/disables domains for a user, restore writes back the " +
  "state recorded before the first change, or the closest shell-settable state with a note. Returns what changed, skipped domains, the per-domain state after, " +
  "and a restore receipt; in a daemon session, release or rebind restores it. Read state with " +
  "getDeepLinks.";

export function registerAppLinkTools(deps: SetAppLinksToolDependencies = {}): void {
  ToolRegistry.registerDeviceAware("setAppLinks", SET_APP_LINKS_DESCRIPTION, setAppLinksSchema, {
    handler: createSetAppLinksHandler(deps),
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    outputSchema: setAppLinksResultSchema,
  });
}
