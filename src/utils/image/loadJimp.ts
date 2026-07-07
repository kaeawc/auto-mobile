/** Lazy, memoized loader for a Jimp constructor without the WebP WASM plugin. */
async function buildJimp() {
  const [{ createJimp }, { defaultFormats, defaultPlugins }] = await Promise.all([
    import("@jimp/core"),
    import("jimp"),
  ]);
  return createJimp({ formats: defaultFormats, plugins: defaultPlugins });
}

export type JimpConstructor = Awaited<ReturnType<typeof buildJimp>>;
export type JimpImage = InstanceType<JimpConstructor>;

let jimpPromise: Promise<JimpConstructor> | undefined;

export async function loadJimp(): Promise<JimpConstructor> {
  jimpPromise ??= buildJimp();
  return jimpPromise;
}
