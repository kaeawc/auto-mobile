import { ENV, readEnvBool } from "./env";

/** Optional tool definitions register eagerly only when `AUTOMOBILE_ALWAYS_LOAD_TOOLS` is set to `1`/`true`. */
export function isAlwaysLoadToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readEnvBool(ENV.ALWAYS_LOAD_TOOLS, env);
}
