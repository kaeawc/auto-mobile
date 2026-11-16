import { builtinModules } from "node:module";

const builtins = new Set(builtinModules);

export interface BrowserBundle {
  code: string;
  /** Minified bytes of every build output (HTML, JS and CSS), summed. */
  totalBytes: number;
  /** Each Node builtin the closure reached, with its importer. */
  builtins: string[];
  inputs: string[];
}

/** Bundles `entry` for the browser, minified, recording every Node builtin it reaches (#16451). */
export async function bundleForBrowser(entry: string): Promise<BrowserBundle> {
  const reached = new Set<string>();
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    minify: true,
    metafile: true,
    plugins: [
      {
        name: "record-node-builtins",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            const name = args.path.replace(/^node:/, "");
            if (args.path.startsWith("node:") || builtins.has(name.split("/")[0] ?? name)) {
              reached.add(`${args.path} (from ${args.importer})`);
              return { path: args.path, external: true };
            }
            return undefined;
          });
        },
      },
    ],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `browser build of ${entry} failed`);
  }
  return {
    code: await result.outputs[0].text(),
    totalBytes: result.outputs.reduce((sum, output) => sum + output.size, 0),
    builtins: [...reached],
    inputs: Object.keys(result.metafile?.inputs ?? {}),
  };
}
