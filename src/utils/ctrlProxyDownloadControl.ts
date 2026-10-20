import { readBooleanFlag } from "./flagTokens";
import { ENV } from "../config/env";

export const SKIP_CTRL_PROXY_DOWNLOAD_FLAG = "--skip-ctrl-proxy-download";
export const LEGACY_SKIP_ACCESSIBILITY_DOWNLOAD_FLAG = "--skip-accessibility-download";
export const SKIP_CTRL_PROXY_DOWNLOAD_ENV = ENV.SKIP_CTRL_PROXY_DOWNLOAD.name;

export function isTruthyEnvValue(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function shouldSkipCtrlProxyDownload(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // An explicit `--skip-ctrl-proxy-download=false` on the command line beats the env var.
  return (
    readBooleanFlag(args, [
      SKIP_CTRL_PROXY_DOWNLOAD_FLAG,
      LEGACY_SKIP_ACCESSIBILITY_DOWNLOAD_FLAG,
    ]) ?? isTruthyEnvValue(env[SKIP_CTRL_PROXY_DOWNLOAD_ENV])
  );
}
