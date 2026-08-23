/**
 * iosDelegateHarness - a minimal, socket-free driver for iOS CtrlProxy delegate
 * classes (`CtrlProxyStorage`, `CtrlProxyDatabase`, `CtrlProxyVoiceOver`,
 * `CtrlProxyHierarchy`, …).
 *
 * The delegates all take a {@link HierarchyDelegateContext} and correlate
 * requests through a real {@link RequestManager} driven by a {@link FakeTimer}.
 * This harness wires exactly that: a real `RequestManager(timer)`, a capturing
 * "web socket" whose sends are parsed into {@link IosDelegateHarness.sentMessages},
 * and toggles for the connection / advertised-command / cache state a delegate
 * reads.
 *
 * It deliberately does NOT run `decodeCtrlProxyMessage`; a test injects the
 * already-decoded result with {@link IosDelegateHarness.resolveLast}. Client-level
 * round-trip coverage (real `FakeWebSocket` + real decode) lives in the
 * `IOSCtrlProxyClient`-driven suites, not here.
 *
 * Time is fully controlled: nothing auto-advances. To fire a request's timeout,
 * call {@link IosDelegateHarness.advanceTime} past the delegate's `timeoutMs` so
 * the assertion (not a real hang) proves the timeout path.
 */

import type WebSocket from "ws";
import { RequestManager } from "../../src/utils/RequestManager";
import type { PerformanceTracker } from "../../src/utils/PerformanceTracker";
import type {
  HierarchyDelegateContext,
  CtrlProxyCachedHierarchy,
} from "../../src/features/observe/ios/types";
import { FakeTimer } from "../fakes/FakeTimer";

/** Options for {@link createIosDelegateHarness}. */
export interface IosDelegateHarnessOptions {
  /** Injected fake clock; a fresh one is created when omitted. */
  timer?: FakeTimer;
  /** Initial value returned by `ensureConnected()`. Defaults to `true`. */
  connected?: boolean;
  /** `cacheFreshTtlMs` on the context. Defaults to 500. */
  cacheFreshTtlMs?: number;
  /** Seed the cached hierarchy. Defaults to `null`. */
  initialCache?: CtrlProxyCachedHierarchy | null;
  /**
   * Advertised command set. When set, `isCommandSupported` answers membership;
   * when omitted, every command is considered supported.
   */
  supportedCommands?: string[];
}

/** The object returned by {@link createIosDelegateHarness}. */
export interface IosDelegateHarness {
  /** The fake clock shared by the context and the RequestManager. */
  timer: FakeTimer;
  /** The real RequestManager the context correlates requests through. */
  requestManager: RequestManager;
  /** The context to hand to a delegate constructor. */
  context: HierarchyDelegateContext;
  /** Every message sent through the fake socket, parsed as a JSON object. */
  sentMessages: Array<Record<string, unknown>>;
  /** How many times `cancelScreenshotBackoff()` has been invoked. */
  cancelScreenshotBackoffCalls: number;
  /** How many times `ensureConnected()` has been invoked. */
  ensureConnectedCalls: number;
  /** Change the value `ensureConnected()` resolves to. */
  setConnected(connected: boolean): void;
  /** Replace the advertised command set (`undefined` = all supported). */
  setSupportedCommands(commands: string[] | undefined): void;
  /** The requestId of the most-recently-registered pending request, or `null`. */
  lastRequestId(): string | null;
  /** Resolve the most-recently-registered pending request with a decoded result. */
  resolveLast<T>(result: T): boolean;
  /** Resolve a specific pending request id with a decoded result. */
  resolve<T>(id: string, result: T): boolean;
  /** Advance the fake clock, firing any request timeouts that come due. */
  advanceTime(ms: number): void;
}

/**
 * Build an {@link IosDelegateHarness}. See the file header for the contract.
 */
export function createIosDelegateHarness(
  options: IosDelegateHarnessOptions = {},
): IosDelegateHarness {
  const timer = options.timer ?? new FakeTimer();
  const requestManager = new RequestManager(timer);
  const sentMessages: Array<Record<string, unknown>> = [];

  let connected = options.connected ?? true;
  let supportedCommands = options.supportedCommands;
  let cache: CtrlProxyCachedHierarchy | null = options.initialCache ?? null;

  const fakeSocket = {
    send(data: unknown): void {
      const text = typeof data === "string" ? data : String(data);
      try {
        sentMessages.push(JSON.parse(text) as Record<string, unknown>);
      } catch {
        // A delegate should only ever send JSON; a parse failure is a test bug,
        // surfaced by the missing/wrong entry in sentMessages rather than a throw.
        sentMessages.push({ raw: text });
      }
    },
  } as unknown as WebSocket;

  const harness: IosDelegateHarness = {
    timer,
    requestManager,
    sentMessages,
    cancelScreenshotBackoffCalls: 0,
    ensureConnectedCalls: 0,
    setConnected(next: boolean): void {
      connected = next;
    },
    setSupportedCommands(commands: string[] | undefined): void {
      supportedCommands = commands;
    },
    lastRequestId(): string | null {
      const ids = requestManager.getPendingIds();
      return ids.length > 0 ? ids[ids.length - 1] : null;
    },
    resolveLast<T>(result: T): boolean {
      const id = this.lastRequestId();
      return id !== null && requestManager.resolve<T>(id, result);
    },
    resolve<T>(id: string, result: T): boolean {
      return requestManager.resolve<T>(id, result);
    },
    advanceTime(ms: number): void {
      timer.advanceTime(ms);
    },
    context: {
      getWebSocket: (): WebSocket | null => fakeSocket,
      requestManager,
      timer,
      ensureConnected: async (_perf?: PerformanceTracker): Promise<boolean> => {
        harness.ensureConnectedCalls++;
        return connected;
      },
      isCommandSupported: (messageType: string): boolean =>
        supportedCommands === undefined || supportedCommands.includes(messageType),
      unsupportedCommandError: (messageType: string): string =>
        `${messageType} is not supported by the connected device service`,
      cancelScreenshotBackoff: (): void => {
        harness.cancelScreenshotBackoffCalls++;
      },
      cacheFreshTtlMs: options.cacheFreshTtlMs ?? 500,
      getCachedHierarchy: (): CtrlProxyCachedHierarchy | null => cache,
      setCachedHierarchy: (next: CtrlProxyCachedHierarchy | null): void => {
        cache = next;
      },
    },
  };

  return harness;
}
