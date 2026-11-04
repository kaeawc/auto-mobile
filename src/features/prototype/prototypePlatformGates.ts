import { expandPrototypeComponents } from "./prototypeComponents";
import { prototypeRealtimeFields } from "./prototypeChannels";
import { prototypeMediaQueueFields } from "./prototypeMediaQueue";
import { PROTOTYPE_PLATFORM_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import {
  PROTOTYPE_PLATFORM_MODULES,
  prototypePlatformCall,
  prototypePlatformEvent,
  prototypePlatformEventModule,
  prototypePlatformPointerModule,
  prototypePlatformUses,
  type PrototypePlatformUse,
} from "./prototypePlatform";

/**
 * The generated capability gates for the platform vocabulary (#14294): the authored paths that
 * need `prototype_platform_v1`, one `prototype_platform_<module>_v1` per module, and one gate per
 * per-call capability, each with its unsupported-device message.
 */

/** A capability a call or an event's handlers need on top of the module's. */
type Cap = { capability?: string };

/** The modules a use needs: its own for calls, handlers, reads and declarations. */
function usedModule(use: PrototypePlatformUse): string | undefined {
  switch (use.kind) {
    case "declared":
    case "node":
      return use.module;
    case "handler":
      return prototypePlatformEventModule(use.event);
    case "call":
      return prototypePlatformCall(use.action.call)?.module;
    case "read":
      return prototypePlatformPointerModule(use.pointer);
    default:
      return undefined;
  }
}

/**
 * Uses at authored paths: the expanded tree's uses located back through component expansion,
 * then the component definitions no expansion visited (the `prototypeFieldsOfKind` order).
 */
function authoredUses(spec: unknown): PrototypePlatformUse[] {
  const authored = prototypePlatformUses(spec);
  const expansion = expandPrototypeComponents(spec);
  if (!expansion.success || !expansion.expanded) {
    return authored;
  }
  const located = prototypePlatformUses(expansion.spec).map((use) => ({
    ...use,
    path: expansion.locate(use.path),
  }));
  const paths = new Set(located.map((use) => use.path));
  return [
    ...located,
    ...authored.filter(
      (use) => !paths.has(use.path) && !located.some((at) => at.path.endsWith(` → ${use.path}`)),
    ),
  ];
}

const unique = (paths: string[]): string[] => [...new Set(paths)];

/** Authored paths needing `prototype_platform_v1`: every platform construct. */
export function prototypePlatformFields(spec: unknown): string[] {
  return unique(authoredUses(spec).map((use) => use.path));
}

/** Authored paths needing one module's capability. */
export function prototypePlatformModuleFields(spec: unknown, name: string): string[] {
  return unique(
    [
      ...(name === "realtime"
        ? prototypeRealtimeFields(spec).map((path) => ({
            kind: "declared" as const,
            path,
            module: name,
          }))
        : []),
      ...authoredUses(spec),
    ]
      .filter((use) => usedModule(use) === name)
      .map((use) => use.path),
  );
}

function unsupported(
  fields: readonly string[],
  platform: "android" | "ios",
  capability: string,
  what: string,
): string {
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${capability}, so it cannot run ${what} at ${fields[0]}${more}. Nothing was shown. ${update}, or use a spec without it.`;
}

export function prototypePlatformUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return unsupported(fields, platform, PROTOTYPE_PLATFORM_CAPABILITY, "the platform vocabulary");
}

/** Authored call and handler paths whose definition names `capability` beyond its module's. */
export function prototypePlatformCallCapabilityFields(spec: unknown, capability: string): string[] {
  return unique(
    authoredUses(spec)
      .filter(
        (use) =>
          (use.kind === "call" &&
            prototypePlatformCall(use.action.call)?.definition.capability === capability) ||
          (use.kind === "handler" &&
            prototypePlatformEvent(use.event)?.definition.capability === capability),
      )
      .map((use) => use.path),
  );
}

/** Authored `backend` paths of the module's nodes that name `backend` (#14302). */
export function prototypePlatformBackendFields(
  spec: unknown,
  name: string,
  backend: string,
): string[] {
  return unique(
    authoredUses(spec)
      .filter((use) => use.kind === "node" && use.module === name && use.backend === backend)
      .map((use) => `${use.path}.backend`),
  );
}

/** The per-call and per-event capabilities in module order, each with what needs it. */
const callCapabilities = (): { capability: string; calls: string[] }[] => {
  const byCapability = new Map<string, string[]>();
  for (const [name, definition] of Object.entries(PROTOTYPE_PLATFORM_MODULES)) {
    const members: [string, Cap][] = [
      ...Object.entries(definition.calls).map(([op, call]): [string, Cap] => [
        `\`${name}.${op}\``,
        call,
      ]),
      ...Object.entries(definition.events).map(([e, ev]): [string, Cap] => [
        `a \`${name}.${e}\` handler`,
        ev,
      ]),
    ];
    for (const [member, { capability }] of members) {
      if (capability) {
        byCapability.set(capability, [...(byCapability.get(capability) ?? []), member]);
      }
    }
  }
  return [...byCapability].map(([capability, calls]) => ({ capability, calls }));
};

/** Spec fields beyond its calls that a per-call capability also gates: a queued player (#14249). */
const CALL_CAPABILITY_FIELDS: Record<
  string,
  { fields: (spec: unknown) => string[]; name: string }
> = {
  prototype_platform_media_queue_v1: {
    fields: prototypeMediaQueueFields,
    name: "a media player `queue`",
  },
};

/** One generated gate per per-call capability, after the module gates. */
const PROTOTYPE_PLATFORM_CALL_GATES = callCapabilities().map(({ capability, calls }) => ({
  capability,
  fields: (spec: unknown) => [
    ...(CALL_CAPABILITY_FIELDS[capability]?.fields(spec) ?? []),
    ...prototypePlatformCallCapabilityFields(spec, capability),
  ],
  unsupportedMessage: (fields: readonly string[], platform: "android" | "ios") =>
    unsupported(
      fields,
      platform,
      capability,
      [
        ...calls,
        ...(CALL_CAPABILITY_FIELDS[capability] ? [CALL_CAPABILITY_FIELDS[capability].name] : []),
      ].join(" or "),
    ),
}));

/** One generated gate per module in the `platformModules` table, then one per call capability. */
const PROTOTYPE_PLATFORM_MODULE_ONLY_GATES = Object.entries(PROTOTYPE_PLATFORM_MODULES).flatMap(
  ([name, definition]) => [
    {
      capability: definition.capability,
      fields: (spec: unknown) => prototypePlatformModuleFields(spec, name),
      unsupportedMessage: (fields: readonly string[], platform: "android" | "ios") =>
        unsupported(fields, platform, definition.capability, `the ${name} platform module`),
    },
    ...Object.entries(definition.backends ?? {}).map(([backend, { capability }]) => ({
      capability,
      fields: (spec: unknown) => prototypePlatformBackendFields(spec, name, backend),
      unsupportedMessage: (fields: readonly string[], platform: "android" | "ios") =>
        unsupported(fields, platform, capability, `the ${name} \`${backend}\` backend`),
    })),
    ...(definition.deviceCapability
      ? [
          {
            capability: definition.deviceCapability,
            fields: (spec: unknown) => prototypeRealtimeFields(spec, true),
            unsupportedMessage: (fields: readonly string[], platform: "android" | "ios") =>
              unsupported(
                fields,
                platform,
                definition.deviceCapability!,
                "device realtime channels",
              ),
          },
        ]
      : []),
  ],
);

export const PROTOTYPE_PLATFORM_MODULE_GATES = [
  ...PROTOTYPE_PLATFORM_MODULE_ONLY_GATES,
  ...PROTOTYPE_PLATFORM_CALL_GATES,
];
