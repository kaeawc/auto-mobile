// Bundles the prototype web renderer from src/features/prototype/web/ into dist/index.js for the
// browser (#16453). Run from this directory: `bun run build`. Nothing is installed here; the
// bundle inlines everything it reaches, so the package has no dependencies.
import { fileURLToPath } from "node:url";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** The library bundle's source; the screenshot check loads the same build. */
export async function buildPrototypeWebLibrary(outdir?: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [here("./src/index.ts")],
    ...(outdir ? { outdir } : {}),
    naming: "index.js",
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
  const code = await buildPrototypeWebLibrary(here("./dist"));
  console.log(`prototype-web: dist/index.js, ${Buffer.byteLength(code)} bytes minified`);
}
