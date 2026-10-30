import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import type { PrototypePlatformError } from "./prototypePlatform";
import { record, type Raw } from "./prototypeTemplate";

/**
 * Rules for the `cameraPreview` node (#14202) that the contract cannot express: at most one per
 * spec, an id that `camera.*` calls name as `preview`, `camera` in `requires.platform` and
 * `requires.permissions`, and lens, flash and zoom keys that name declared state of the right type.
 */

const CAMERA_PREVIEW_CALLS = new Set([
  "camera.takePhoto",
  "camera.startRecording",
  "camera.stopRecording",
]);

/** The ids of the spec's `cameraPreview` nodes, the values a `camera.*` `preview` may name. */
export function prototypeCameraPreviewIds(root: Raw): Set<string> {
  const ids = new Set<string>();
  walkPrototypeNodes(root, (node) => {
    if (node.type === "cameraPreview" && typeof node.id === "string") {
      ids.add(node.id);
    }
  });
  return ids;
}

/** The first `cameraPreview` node rule a spec breaks. */
export function prototypeCameraPreviewError(root: Raw): PrototypePlatformError | undefined {
  const previews: { node: Raw; path: string }[] = [];
  walkPrototypeNodes(root, (node, path) => {
    if (node.type === "cameraPreview") {
      previews.push({ node, path });
    }
  });
  const requires = record(root.requires);
  const platform = Array.isArray(requires?.platform) ? requires.platform : [];
  const permissions = (Array.isArray(requires?.permissions) ? requires.permissions : []).map(
    (permission) => record(permission)?.name,
  );
  const state = record(root.state) ?? {};
  for (const [index, { node, path }] of previews.entries()) {
    const error =
      index > 0
        ? { path, message: "At most one cameraPreview per prototype" }
        : nodeError(node, path, {
            camera: platform.includes("camera"),
            permission: permissions.includes("camera"),
            state,
          });
    if (error) {
      return error;
    }
  }
  return undefined;
}

const STATE_KEYS = [
  ["lensKey", "string"],
  ["flashKey", "string"],
  ["zoomKey", "number"],
] as const;

function nodeError(
  node: Raw,
  path: string,
  scope: { camera: boolean; permission: boolean; state: Raw },
): PrototypePlatformError | undefined {
  if (!scope.camera) {
    return { path, message: "cameraPreview requires camera in requires.platform" };
  }
  if (!scope.permission) {
    return { path, message: "cameraPreview requires permission camera in requires.permissions" };
  }
  if (typeof node.id !== "string" || !prototypeContractPatterns.stateKey.test(node.id)) {
    return { path, message: "A cameraPreview needs an id that is a state key" };
  }
  for (const [field, type] of STATE_KEYS) {
    const key = node[field];
    if (typeof key === "string" && typeof scope.state[key] !== type) {
      return {
        path: `${path}.${field}`,
        message: `${field} must name a declared ${type} state key`,
      };
    }
  }
  return undefined;
}

/** A viewfinder `camera.*` call whose literal `preview` argument names no `cameraPreview` node. */
export function prototypeCameraCallError(
  action: Raw,
  path: string,
  previews: ReadonlySet<string>,
): PrototypePlatformError | undefined {
  if (typeof action.call !== "string" || !CAMERA_PREVIEW_CALLS.has(action.call)) {
    return undefined;
  }
  const preview = record(record(action.args)?.preview);
  return preview && typeof preview.value === "string" && !previews.has(preview.value)
    ? { path: `${path}.args.preview.value`, message: "Unknown camera preview" }
    : undefined;
}
