import { parseStringPromise } from "xml2js";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { parseBoundsString } from "../../utils/bounds";
import type { Timer } from "../../utils/SystemTimer";
import { uiautomatorDumpLock } from "../action/uiautomatorDumpLock";
import type { AndroidAutoScreenDriver } from "./AndroidAutoSettingsUi";

/** One node of a `uiautomator dump`, reduced to what text-level driving reads. */
export interface ScreenNode {
  text: string;
  contentDesc: string;
  checkable: boolean;
  checked: boolean;
  bounds: { left: number; top: number; right: number; bottom: number };
}

interface XmlNode {
  $?: Record<string, string>;
  node?: XmlNode[];
}

function flatten(nodes: readonly XmlNode[]): ScreenNode[] {
  return nodes.flatMap((node) => {
    const attributes = node.$ ?? {};
    const bounds = parseBoundsString(attributes.bounds ?? "");
    const own: ScreenNode[] =
      bounds && bounds.right > bounds.left && bounds.bottom > bounds.top
        ? [
            {
              text: attributes.text ?? "",
              contentDesc: attributes["content-desc"] ?? "",
              checkable: attributes.checkable === "true",
              checked: attributes.checked === "true",
              bounds,
            },
          ]
        : [];
    return [...own, ...flatten(node.node ?? [])];
  });
}

/** Parses a `uiautomator dump` into on-screen nodes; a dump with no hierarchy is an empty screen. */
export async function parseScreenNodes(xml: string): Promise<ScreenNode[]> {
  const start = xml.indexOf("<?xml");
  const body = start >= 0 ? xml.slice(start) : xml;
  if (!body.includes("<hierarchy")) {
    return [];
  }
  const parsed: { hierarchy?: XmlNode } = await parseStringPromise(body, { explicitArray: true });
  return flatten(parsed.hierarchy?.node ?? []);
}

export function findByText(nodes: readonly ScreenNode[], text: string): ScreenNode | undefined {
  return nodes.find((node) => node.text === text || node.contentDesc === text);
}

/** The checkable node on the same row as `label` (its vertical centre falls inside the row). */
export function switchInRow(
  nodes: readonly ScreenNode[],
  label: ScreenNode,
): ScreenNode | undefined {
  const centreY = (label.bounds.top + label.bounds.bottom) / 2;
  return nodes.find(
    (node) => node.checkable && node.bounds.top <= centreY && centreY <= node.bounds.bottom,
  );
}

function centre(node: ScreenNode): { x: number; y: number } {
  return {
    x: Math.round((node.bounds.left + node.bounds.right) / 2),
    y: Math.round((node.bounds.top + node.bounds.bottom) / 2),
  };
}

/** Content description of the overflow (three-dot) button in Android Auto's settings toolbar. */
export const OVERFLOW_MENU_LABEL = "More options";

export interface AdbAndroidAutoScreenDriverOptions {
  /** Pause before each screen read so a just-started activity or tap has rendered. */
  settleMs: number;
  /** Screen reads before `tapText` reports its text as missing. */
  findAttempts: number;
  /** Swipes before `scrollToText` reports its text as missing. */
  maxScrolls: number;
}

export const DEFAULT_SCREEN_DRIVER_OPTIONS: AdbAndroidAutoScreenDriverOptions = {
  settleMs: 750,
  findAttempts: 4,
  maxScrolls: 8,
};

const DUMP_PATH = "/data/local/tmp/automobile-android-auto.xml";
const SHELL_TIMEOUT_MS = 15_000;

/**
 * Reads the phone screen with `uiautomator dump` and acts with `input`, so Android Auto's
 * settings can be driven on a fresh emulator before AutoMobile's on-device service exists.
 * Every dump holds the device's shared dump lock.
 */
export class AdbAndroidAutoScreenDriver implements AndroidAutoScreenDriver {
  constructor(
    private readonly adb: Pick<AdbExecutor, "execute">,
    private readonly deviceId: string,
    private readonly timer: Timer,
    private readonly options: AdbAndroidAutoScreenDriverOptions = DEFAULT_SCREEN_DRIVER_OPTIONS,
  ) {}

  async isTextVisible(text: string, signal?: AbortSignal): Promise<boolean> {
    return findByText(await this.readScreen(signal), text) !== undefined;
  }

  async tapText(text: string, signal?: AbortSignal): Promise<void> {
    await this.tap(await this.waitFor(text, signal), signal);
  }

  async scrollToText(text: string, signal?: AbortSignal): Promise<void> {
    for (let scroll = 0; scroll <= this.options.maxScrolls; scroll++) {
      const nodes = await this.readScreen(signal);
      if (findByText(nodes, text)) {
        return;
      }
      if (scroll < this.options.maxScrolls) {
        await this.swipeUp(nodes, signal);
      }
    }
    throw new ActionableError(
      `"${text}" did not appear on the phone screen after ${this.options.maxScrolls} scrolls. Check that the emulator's language is English and that Android Auto's settings are open.`,
    );
  }

  async isSwitchOn(label: string, signal?: AbortSignal): Promise<boolean> {
    const nodes = await this.readScreen(signal);
    const row = findByText(nodes, label);
    const toggle = row ? switchInRow(nodes, row) : undefined;
    if (!toggle) {
      throw new ActionableError(
        `No switch was found on the "${label}" row of the phone screen; cannot read whether it is on.`,
      );
    }
    return toggle.checked;
  }

  async openOverflowMenu(signal?: AbortSignal): Promise<void> {
    await this.tapText(OVERFLOW_MENU_LABEL, signal);
  }

  async pressBack(signal?: AbortSignal): Promise<void> {
    await this.shell(["input", "keyevent", "KEYCODE_BACK"], signal);
  }

  private async waitFor(text: string, signal?: AbortSignal): Promise<ScreenNode> {
    for (let attempt = 0; attempt < this.options.findAttempts; attempt++) {
      const node = findByText(await this.readScreen(signal), text);
      if (node) {
        return node;
      }
    }
    throw new ActionableError(
      `"${text}" is not on the phone screen after ${this.options.findAttempts} reads. Check that the emulator's language is English and that Android Auto's settings are open.`,
    );
  }

  private async tap(node: ScreenNode, signal?: AbortSignal): Promise<void> {
    const { x, y } = centre(node);
    await this.shell(["input", "tap", String(x), String(y)], signal);
  }

  /** Swipes from 80% to 30% of the screen height, measured from the dump's outermost node. */
  private async swipeUp(nodes: readonly ScreenNode[], signal?: AbortSignal): Promise<void> {
    const screen = nodes[0]?.bounds ?? { left: 0, top: 0, right: 1080, bottom: 2400 };
    const x = Math.round((screen.left + screen.right) / 2);
    const height = screen.bottom - screen.top;
    const from = Math.round(screen.top + height * 0.8);
    const to = Math.round(screen.top + height * 0.3);
    await this.shell(
      ["input", "swipe", String(x), String(from), String(x), String(to), "300"],
      signal,
    );
  }

  private async readScreen(signal?: AbortSignal): Promise<ScreenNode[]> {
    await this.timer.sleep(this.options.settleMs);
    signal?.throwIfAborted();
    // The old dump is removed first: `uiautomator dump` can fail (for example "could not get
    // idle state") and still exit 0, and reading the previous file would act on a stale screen.
    // A missing file reads as an empty screen, which the callers' bounded retries handle.
    const xml = await uiautomatorDumpLock(this.deviceId).runExclusive(async () => {
      await this.shell(["rm", "-f", DUMP_PATH], signal);
      await this.shell(["uiautomator", "dump", DUMP_PATH], signal);
      return this.shell([`cat ${DUMP_PATH} 2>/dev/null || true`], signal);
    });
    return parseScreenNodes(xml);
  }

  private async shell(args: string[], signal?: AbortSignal): Promise<string> {
    let result;
    try {
      result = await this.adb.execute(["shell", ...args], {
        timeoutMs: SHELL_TIMEOUT_MS,
        signal,
        noRetry: true,
      });
    } catch (error) {
      throw toActionableError(error, `Android Auto provisioning: adb shell ${args[0]} failed`);
    }
    if (result.error) {
      throw new ActionableError(
        `Android Auto provisioning: adb shell ${args.join(" ")} failed: ${result.error}`,
      );
    }
    return result.stdout;
  }
}
