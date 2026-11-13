import { prototypeDataPathPointer } from "./prototypeData";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import type { PrototypePlatformError } from "./prototypePlatform";
import { record, type Raw } from "./prototypeTemplate";
import contract from "../../../schemas/prototype-spec-contract.json";

/**
 * Emit-context names the runtime adds to every `emit` a marker tap runs (#16492): `markerId` is the
 * tapped marker's resolved `id` template. An authored context entry under one of these names is refused.
 */
export const PROTOTYPE_MARKER_TAP_EMIT_CONTEXT: readonly string[] =
  contract.platformModules.map.events.markerTap.emitContext;

/** Action lists nested in an action; a marker tap's id stays fixed for all of them. */
const NESTED_ACTION_LISTS = ["onSuccess", "onError", "actions"] as const;

/**
 * Rules for the `map` node (#14309) that the contract cannot express: a map needs `map` in
 * `requires.platform`; `showUserLocation` reads the `location` module, so it also needs `location`
 * in `requires.platform` and the `location` permission in `requires.permissions`; and
 * `onCameraIdle.into` is a `/data` write path. An `emit` that `onMarkerTap` runs cannot author a
 * context name the runtime adds (`markerId`).
 */
export function prototypeMapError(root: Raw): PrototypePlatformError | undefined {
  const requires = record(root.requires) ?? {};
  const platform = Array.isArray(requires.platform) ? requires.platform : [];
  const permissions = Array.isArray(requires.permissions) ? requires.permissions : [];
  const scope = {
    map: platform.includes("map"),
    location: platform.includes("location"),
    permission: permissions.some((entry) => record(entry)?.name === "location"),
  };
  let first: PrototypePlatformError | undefined;
  walkPrototypeNodes(root, (node, path) => {
    if (!first && node.type === "map") {
      first = mapNodeError(node, path, scope);
    }
  });
  return first;
}

function mapNodeError(
  node: Raw,
  path: string,
  scope: { map: boolean; location: boolean; permission: boolean },
): PrototypePlatformError | undefined {
  const fail = (at: string, message: string) => ({ path: at, message });
  if (!scope.map) {
    return fail(path, "map requires map in requires.platform");
  }
  if (node.showUserLocation === true && !scope.location) {
    return fail(
      `${path}.showUserLocation`,
      "showUserLocation requires location in requires.platform",
    );
  }
  if (node.showUserLocation === true && !scope.permission) {
    return fail(
      `${path}.showUserLocation`,
      "showUserLocation requires permission location in requires.permissions",
    );
  }
  const into = record(node.onCameraIdle)?.into;
  if (into !== undefined && prototypeDataPathPointer(into) === undefined) {
    return fail(`${path}.onCameraIdle.into`, "onCameraIdle.into must be a /data/<pointer> path");
  }
  return markerTapContextError(node.onMarkerTap, `${path}.onMarkerTap`);
}

/** The first emit under a marker tap, depth first, whose context authors a runtime-added name. */
function markerTapContextError(actions: unknown, path: string): PrototypePlatformError | undefined {
  if (!Array.isArray(actions)) {
    return undefined;
  }
  for (const [index, entry] of actions.entries()) {
    const action = record(entry) ?? {};
    const at = `${path}[${index}]`;
    const context = action.type === "emit" ? record(action.context) : undefined;
    const name = PROTOTYPE_MARKER_TAP_EMIT_CONTEXT.find(
      (candidate) => context !== undefined && Object.hasOwn(context, candidate),
    );
    if (name !== undefined) {
      return {
        path: `${at}.context.${name}`,
        message: `${name} is reserved in an onMarkerTap emit context: the runtime sets it to the tapped marker's id`,
      };
    }
    for (const list of NESTED_ACTION_LISTS) {
      const found = markerTapContextError(action[list], `${at}.${list}`);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

const MARKER_PLACEHOLDER = /\{[^{}]+\}/;

/**
 * The image asset id a map node's `markers.icon` names (#16491), or undefined for a Material icon
 * name. An id with a `{alias.field}` placeholder is a per-marker template, not an asset reference.
 */
export function prototypeMapMarkerAsset(node: Raw): string | undefined {
  const asset = record(record(record(node.markers)?.icon))?.asset;
  return typeof asset === "string" && !MARKER_PLACEHOLDER.test(asset) ? asset : undefined;
}

/** The first map whose `markers.icon.asset` is not in a complete uploaded asset inventory. */
export function prototypeMapMarkerAssetsError(
  spec: unknown,
  assets: ReadonlySet<string>,
): PrototypePlatformError | undefined {
  let first: PrototypePlatformError | undefined;
  walkPrototypeNodes(spec, (node, path) => {
    const asset = node.type === "map" ? prototypeMapMarkerAsset(node) : undefined;
    if (!first && asset !== undefined && !assets.has(asset)) {
      first = { path: `${path}.markers.icon.asset`, message: "Unknown marker asset" };
    }
  });
  return first;
}
