import { boundedPrototypeError } from "./prototypeErrors";
import { ENV, readEnvRaw } from "../../config/env";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";
import type { PrototypeAssetUpload } from "./prototypeAssets";
import { PROTOTYPE_SHADER_MIME_TYPE, validatePrototypeShaderSource } from "./prototypeShaderSource";

export const PROTOTYPE_SHADERS_OPT_IN_ERROR =
  "Custom prototype shaders are off by default. Set AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS=1 in the host environment, then restart the daemon; use an Android device advertising prototype_custom_shaders_v1.";

export function prototypeShadersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Unlike general boolean flags, this security opt-in accepts only the exact value 1.
  return readEnvRaw(ENV.PROTOTYPE_CUSTOM_SHADERS, env) === "1";
}

export function prototypeShaderUses(
  spec: unknown,
): { shader: Record<string, unknown>; path: string }[] {
  const uses: { shader: Record<string, unknown>; path: string }[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    const styles = [
      { style: node.style, path: `${path}.style` },
      ...(Array.isArray(node.styleWhen) ? node.styleWhen : []).map((entry, index) => ({
        style: record(entry)?.style,
        path: `${path}.styleWhen[${index}].style`,
      })),
    ];
    for (const entry of styles) {
      const shader = record(record(entry.style)?.shader);
      if (shader) {
        uses.push({ shader, path: `${entry.path}.shader` });
      }
    }
  });
  return uses;
}

export function prototypeShaderFields(spec: unknown): string[] {
  return prototypeShaderUses(spec).map(({ path }) => path);
}

export function prototypeShadersUnsupportedMessage(
  _fields: readonly string[],
  platform: "android" | "ios",
): string {
  return platform === "ios"
    ? "iOS prototype agents refuse style.shader: custom AGSL shaders are Android-only. Remove style.shader."
    : "The connected CtrlProxy does not advertise prototype_custom_shaders_v1. Update CtrlProxy to a build supporting custom AGSL shaders, or remove style.shader.";
}

export function prototypeShaderOptInProblem(
  spec: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return prototypeShaderFields(spec).length && !prototypeShadersEnabled(env)
    ? PROTOTYPE_SHADERS_OPT_IN_ERROR
    : undefined;
}

/** Missing assets remain the transport's responsibility; available assets must match exactly. */
export function prototypeShaderAssetProblem(
  spec: unknown,
  assets: readonly PrototypeAssetUpload[],
): string | undefined {
  const available = new Map(assets.map((asset) => [asset.id, asset]));
  for (const { shader, path } of prototypeShaderUses(spec)) {
    const asset = available.get(String(shader.asset));
    if (!asset) {
      continue;
    }
    if (asset.mimeType !== PROTOTYPE_SHADER_MIME_TYPE) {
      return boundedPrototypeError(
        `${path}.asset must reference an application/vnd.automobile.agsl asset.`,
      );
    }
    const checked = validatePrototypeShaderSource(asset.bytes);
    if (!checked.success) {
      return checked.error;
    }
    for (const name of Object.keys(record(shader.uniforms) ?? {})) {
      if (!checked.uniforms.has(name)) {
        return boundedPrototypeError(
          `${path}.uniforms contains a name not declared as uniform float in the AGSL source.`,
        );
      }
    }
  }
  return undefined;
}

/** Resolve only referenced IDs, with same-call uploads taking precedence over older cached bytes. */
export async function cachedPrototypeShaderAssetProblem(
  spec: unknown,
  serial: string,
  cache: Pick<import("./prototypeAssetCache").PrototypeAssetCache, "get">,
  supplied: readonly PrototypeAssetUpload[] = [],
): Promise<string | undefined> {
  const assets = [...supplied];
  const ids = new Set(supplied.map((asset) => asset.id));
  for (const { shader } of prototypeShaderUses(spec)) {
    const id = String(shader.asset);
    if (ids.has(id)) {
      continue;
    }
    ids.add(id);
    const asset = await cache.get(serial, id);
    if (asset) {
      assets.push(asset);
    }
  }
  return prototypeShaderAssetProblem(spec, assets);
}

/** Only replaceNode introduces authored shader vocabulary; /data and /state patches are opaque. */
export function prototypeShaderPatchSpec(ops: readonly { op: string; node?: unknown }[]): unknown {
  return { root: { children: ops.filter((op) => op.op === "replaceNode").map((op) => op.node) } };
}
