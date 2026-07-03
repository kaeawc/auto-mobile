/**
 * Lazy, memoized loader for a Jimp constructor with WebP support.
 *
 * WebP encode/decode comes from the first-party @jimp/wasm-webp plugin,
 * which instantiates a WASM module — keep it off the MCP startup path by
 * loading on first image use, mirroring the old loadSharp pattern.
 */
async function buildJimp() {
  const [{ createJimp }, { defaultFormats, defaultPlugins }, { default: webp }] = await Promise.all([
    import("@jimp/core"),
    import("jimp"),
    import("@jimp/wasm-webp"),
  ]);
  return createJimp({ formats: [...defaultFormats, webp], plugins: defaultPlugins });
}

export type JimpConstructor = Awaited<ReturnType<typeof buildJimp>>;
export type JimpImage = InstanceType<JimpConstructor>;

let jimpPromise: Promise<JimpConstructor> | undefined;

export async function loadJimp(): Promise<JimpConstructor> {
  jimpPromise ??= buildJimp();
  return jimpPromise;
}
