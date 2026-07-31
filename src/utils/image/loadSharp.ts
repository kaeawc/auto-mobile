// sharp 0.35 publishes ESM types where the callable factory is the *default*
// export (`export default sharp`), so `typeof import("sharp")` is the module
// namespace, not the callable. Resolve to the default export when present and
// fall back to the module type for the legacy `export =` shape (sharp ≤0.34).
type SharpModule = typeof import("sharp");
export type SharpFactory = SharpModule extends { default: infer TDefault } ? TDefault : SharpModule;

let sharpFactoryPromise: Promise<SharpFactory> | undefined;

export async function loadSharp(): Promise<SharpFactory> {
  sharpFactoryPromise ??= import("sharp").then(mod => {
    const loaded = mod as unknown as { default?: SharpFactory } & SharpFactory;
    return loaded.default ?? loaded;
  }).catch(error => {
    sharpFactoryPromise = undefined;
    throw error;
  });
  return sharpFactoryPromise;
}
