// Bundles the prototype web renderer from src/features/prototype/web/ into dist/index.js, and the
// <automobile-prototype> element over it into dist/element.js, for the browser (#16453, #16454). Run from this directory: `bun run build`. Nothing is installed here; the
// bundle inlines everything it reaches, so the package has no dependencies.
import { fileURLToPath } from "node:url";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** The package's entry points; each bundles on its own, so `element` holds `mount` too. */
export type PrototypeWebEntry = "index" | "element";

/** The library bundle's source; the screenshot check loads the same build. */
export async function buildPrototypeWebLibrary(
  outdir?: string,
  entry: PrototypeWebEntry = "index",
): Promise<string> {
  const result = await Bun.build({
    entrypoints: [here(`./src/${entry}.ts`)],
    ...(outdir ? { outdir } : {}),
    naming: `${entry}.js`,
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "prototype-web build failed");
  }
  return result.outputs[0].text();
}

if (import.meta.main) {
  for (const entry of ["index", "element"] as const) {
    const code = await buildPrototypeWebLibrary(here("./dist"), entry);
    console.log(`prototype-web: dist/${entry}.js, ${Buffer.byteLength(code)} bytes minified`);
  }
}
