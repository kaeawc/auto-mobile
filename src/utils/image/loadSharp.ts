export type SharpFactory = typeof import("sharp");

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
