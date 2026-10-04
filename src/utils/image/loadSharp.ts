// sharp 0.35 exposes a default export; sharp <=0.34 uses a callable export =.
type SharpModule = typeof import("sharp");
export type SharpFactory = SharpModule extends { default: infer TDefault } ? TDefault : SharpModule;

function isSharpFactory(value: unknown): value is SharpFactory {
  // At the sharp import boundary, both supported export shapes are callable.
  return typeof value === "function";
}

function hasDefaultExport(mod: unknown): mod is { default: SharpFactory } {
  return (
    ((typeof mod === "object" && mod !== null) || typeof mod === "function") &&
    "default" in mod &&
    isSharpFactory(mod.default)
  );
}

export function resolveSharpFactory(mod: unknown): SharpFactory {
  if (hasDefaultExport(mod)) {
    return mod.default;
  }
  if (isSharpFactory(mod)) {
    return mod;
  }
  throw new TypeError("sharp module does not expose a callable factory");
}

let sharpFactoryPromise: Promise<SharpFactory> | undefined;

export async function loadSharp(): Promise<SharpFactory> {
  sharpFactoryPromise ??= import("sharp").then(resolveSharpFactory).catch((error) => {
    sharpFactoryPromise = undefined;
    throw error;
  });
  return sharpFactoryPromise;
}
