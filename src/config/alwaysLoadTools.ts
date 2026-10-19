import { ENV, readEnvRaw } from "./env";

/** Optional tool definitions register eagerly only when `AUTOMOBILE_ALWAYS_LOAD_TOOLS` is exactly `true`. */
export function isAlwaysLoadToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readEnvRaw(ENV.ALWAYS_LOAD_TOOLS, env) === "true";
}
