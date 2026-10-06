import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Lets an action tell the tool call that is running it when its gesture was actually
 * dispatched (#10196). The tool registry records a navigation tool call at tool START, but a
 * `tapOn` may spend seconds searching for its target first; the navigation graph attributes a
 * screen change to a call by how recently the call acted, so it needs the dispatch moment.
 *
 * Ambient on purpose: the action layer has no handle on the registry's recorder, and
 * threading a callback through every action signature would touch each one for a signal only
 * the navigation graph consumes. Outside a scope (a unit test, a direct call) reporting is a
 * no-op, so actions can report unconditionally.
 */
type ToolDispatchReporter = () => void;

const reporters = new AsyncLocalStorage<ToolDispatchReporter>();

/** Run `run` so any `reportToolDispatched()` inside it calls `report`. */
export function runWithToolDispatchReporter<T>(
  report: ToolDispatchReporter | undefined,
  run: () => T,
): T {
  return report ? reporters.run(report, run) : run();
}

/** The running tool's input gesture is being dispatched now. Safe to call more than once. */
export function reportToolDispatched(): void {
  reporters.getStore()?.();
}
