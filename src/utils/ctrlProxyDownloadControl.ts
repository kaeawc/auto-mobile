export const SKIP_CTRL_PROXY_DOWNLOAD_FLAG = "--skip-ctrl-proxy-download";
export const LEGACY_SKIP_ACCESSIBILITY_DOWNLOAD_FLAG = "--skip-accessibility-download";
export const SKIP_CTRL_PROXY_DOWNLOAD_ENV = "AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD";

export function isTruthyEnvValue(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function shouldSkipCtrlProxyDownload(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    args.includes(SKIP_CTRL_PROXY_DOWNLOAD_FLAG) ||
    args.includes(LEGACY_SKIP_ACCESSIBILITY_DOWNLOAD_FLAG) ||
    isTruthyEnvValue(env[SKIP_CTRL_PROXY_DOWNLOAD_ENV])
  );
}
