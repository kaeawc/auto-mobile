type SharpModule = typeof import("sharp");
type SharpFactory = SharpModule["default"];

let sharpFactoryPromise: Promise<SharpFactory> | undefined;

export async function loadSharp(): Promise<SharpFactory> {
  sharpFactoryPromise ??= import("sharp").then(mod => mod.default);
  return sharpFactoryPromise;
}
