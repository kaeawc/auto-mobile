import type { Timer } from "../../src/utils/SystemTimer";

export interface ChromeReader<Chrome, Cdp> {
  chrome: Chrome;
  cdp: Cdp;
}

export interface WhepSubscriptionReader<Chrome, Cdp> extends ChromeReader<Chrome, Cdp> {
  retried: boolean;
}

export interface WhepSubscriptionRecoveryDependencies<Chrome, Cdp> {
  subscribe(cdp: Cdp): Promise<void>;
  launch(): Promise<ChromeReader<Chrome, Cdp>>;
  close(cdp: Cdp): void;
  stop(chrome: Chrome): Promise<void>;
  timer: Pick<Timer, "sleep">;
}

/**
 * Keep the browser-restart retry limited to iOS, where the hosted Chrome
 * renderer flake occurs. Android failures must remain visible to its device lane.
 */
export async function subscribeWhepReaderForPlatform<Chrome, Cdp>(
  platform: string | undefined,
  reader: ChromeReader<Chrome, Cdp>,
  dependencies: WhepSubscriptionRecoveryDependencies<Chrome, Cdp>,
): Promise<WhepSubscriptionReader<Chrome, Cdp>> {
  if (platform === "ios") {
    return recoverWhepSubscription(reader, dependencies);
  }
  await dependencies.subscribe(reader.cdp);
  return { ...reader, retried: false };
}

/**
 * Retry one failed WHEP subscription with a new browser and retain the live
 * replacement so its caller can own normal teardown.
 */
export async function recoverWhepSubscription<Chrome, Cdp>(
  reader: ChromeReader<Chrome, Cdp>,
  dependencies: WhepSubscriptionRecoveryDependencies<Chrome, Cdp>,
): Promise<WhepSubscriptionReader<Chrome, Cdp>> {
  try {
    await dependencies.subscribe(reader.cdp);
    return { ...reader, retried: false };
  } catch (firstError) {
    dependencies.close(reader.cdp);
    await dependencies.stop(reader.chrome);
    await dependencies.timer.sleep(1_000);
    const replacement = await dependencies.launch();
    try {
      await dependencies.subscribe(replacement.cdp);
      return { ...replacement, retried: true };
    } catch (retryError) {
      dependencies.close(replacement.cdp);
      await dependencies.stop(replacement.chrome);
      throw new Error(
        `WHEP recovery reader failed after a fresh-browser retry: ` +
          `first=${firstError instanceof Error ? firstError.message : String(firstError)}; ` +
          `retry=${retryError instanceof Error ? retryError.message : String(retryError)}`,
      );
    }
  }
}
