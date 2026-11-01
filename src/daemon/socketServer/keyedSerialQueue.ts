import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";

/**
 * Per-key serial execution for the control socket's MCP forwards (#11815): one forward at a time
 * per execution key, different keys concurrent. The state is injected so the owner keeps its maps
 * (and the idle-close coupling) while the queue logic stays a free, testable primitive.
 */

/**
 * Bounds how long a forward may park on another forward's execution-key chain. Without it a
 * waiter is only timed out after it acquires the key, so a stuck holder parks it (and its
 * socket's admission queue) forever (issue #6388).
 */
export interface McpForwardChainWait {
  /** Milliseconds this waiter may still spend waiting, read at each acquisition. */
  remainingMs: () => number;
  /** Error to reject with once that budget is spent. */
  timeoutError: (executionKey: string) => Error;
}

export interface KeyedSerialState {
  /** The tail of each key's chain; present exactly while the key has a forward queued or running. */
  tails: Map<string, Promise<void>>;
  /** Client keys to re-arm for idle close once the execution key's chain drains. */
  idleCloseKeys: Map<string, Set<string>>;
  timer: Timer;
  /** A queued forward reached the front of its chain: its client is no longer idle. */
  onAcquired: (idleCloseKey: string) => void;
  /** The chain drained: the client may be closed once idle. */
  onDrained: (idleCloseKey: string) => void;
}

export function runKeyedSerial<T>(
  state: KeyedSerialState,
  executionKey: string,
  fn: () => Promise<T>,
  { idleCloseKey, chainWait }: { idleCloseKey?: string; chainWait?: McpForwardChainWait } = {},
): Promise<T> {
  if (idleCloseKey) {
    const idleCloseKeys = state.idleCloseKeys.get(executionKey) ?? new Set<string>();
    idleCloseKeys.add(idleCloseKey);
    state.idleCloseKeys.set(executionKey, idleCloseKeys);
  }
  const heldTail = state.tails.get(executionKey);
  const previous = heldTail ?? Promise.resolve();
  // Only a contended acquisition needs a bound; an idle key is taken immediately.
  const acquired =
    heldTail && chainWait ? waitForChain(state.timer, executionKey, heldTail, chainWait) : previous;
  const run = acquired.then(() => {
    if (idleCloseKey) {
      state.onAcquired(idleCloseKey);
    }
    return fn();
  });
  // The tail also waits for `previous`: a waiter that gave up must not let the next
  // waiter run concurrently with the forward still holding this key.
  const tail = Promise.all([
    previous,
    run.then(
      () => undefined,
      () => undefined,
    ),
  ]).then(() => undefined);
  state.tails.set(executionKey, tail);
  void tail.finally(() => {
    if (state.tails.get(executionKey) === tail) {
      state.tails.delete(executionKey);
      const idleCloseKeys = state.idleCloseKeys.get(executionKey);
      state.idleCloseKeys.delete(executionKey);
      for (const key of idleCloseKeys ?? []) {
        state.onDrained(key);
      }
    }
  });
  return run;
}

async function waitForChain(
  timer: Timer,
  executionKey: string,
  heldTail: Promise<void>,
  chainWait: McpForwardChainWait,
): Promise<void> {
  try {
    await raceWithDeadline(heldTail, {
      timer,
      timeoutMs: Math.max(0, chainWait.remainingMs()),
      label: `MCP forward wait for ${executionKey}`,
    });
  } catch (error) {
    // Tails never reject, so only the wait bound lands here (issue #6388).
    logger.warn(
      `[McpForward] chain wait expired executionKey=${executionKey}: ${errorMessage(error)}`,
    );
    throw chainWait.timeoutError(executionKey);
  }
}
