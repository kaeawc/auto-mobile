export type CtrlProxyPlatform = "android" | "ios";

/**
 * Rewrite the runner's terse "Unknown command type: X" error into an actionable
 * message pointing at daemon/runner version skew. Non-matching errors pass
 * through unchanged.
 */
export function rewriteUnknownCommandError(error: string, platform: CtrlProxyPlatform): string {
  const match = /^Unknown command type: (.+)$/.exec(error);
  if (!match) {
    return error;
  }

  const command = match[1];
  if (platform === "android") {
    return `Android CtrlProxy APK rejected ${command} as unknown. The runner is likely older than this daemon; rebuild and redeploy android/control-proxy, or point the daemon at a fresh APK with AUTOMOBILE_CTRL_PROXY_APK_PATH.`;
  }

  return `iOS CtrlProxy runner rejected ${command} as unknown. The runner is likely older than this daemon; rebuild and redeploy the iOS CtrlProxy runner from this source checkout, or run the iOS hot-reload watcher with --manage-ios-runner.`;
}
