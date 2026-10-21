export function buildWhepChromeLaunchArgs(options: {
  debugPort: number;
  userDataDir: string;
}): string[] {
  return [
    "--headless=new",
    "--no-proxy-server",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${options.debugPort}`,
    "--no-first-run",
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-default-browser-check",
    "--disable-default-apps",
    `--user-data-dir=${options.userDataDir}`,
    "about:blank",
  ];
}

export function stripChromeUpdaterNoise(log: string): string {
  return log
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line.includes("chrome/updater/") &&
        !line.includes("components/update_client/") &&
        !line.includes("UpdaterMain") &&
        !line.startsWith('{"response":{"server":"prod"') &&
        !line.includes("Omaha response received"),
    )
    .join("\n");
}
