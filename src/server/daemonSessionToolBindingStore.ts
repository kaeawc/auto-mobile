import { installDaemonSessionBindingScopes } from "../daemon/daemonSessionBindingScopes";
import { SessionReleaseBroadcaster } from "../daemon/sessionReleaseBroadcast";
import { SessionToolBindingStore } from "./sessionToolBindingStore";
import { ToolRegistry } from "./toolRegistry";

/**
 * A store whose release teardown follows both release sources (#4611 Gap D):
 *   - the plan-release path, via ToolRegistry's injected teardown handler
 *     (executePlan auto-release, deterministic, works in stdio mode too); and
 *   - heartbeat/idle/explicit releases, via the process-wide
 *     SessionReleaseBroadcaster (#4610), active in daemon mode.
 * Clearing the binding stops a later sessionless tools/list or tools/call from
 * enforcing the released session's stale profile. A list-changed notification is
 * emitted only when a binding actually changed, so a duplicate release signal for
 * the same session is a no-op.
 */
export function createReleaseSubscribedBindingStore(): SessionToolBindingStore {
  return new SessionToolBindingStore({
    subscribeReleases: (onReleased) => {
      const unregister = ToolRegistry.registerSessionBindingReleaseHandler({
        onSessionReleased: onReleased,
      });
      const unsubscribe = SessionReleaseBroadcaster.subscribe((sessionUuid) =>
        onReleased(sessionUuid),
      );
      return () => {
        unregister();
        unsubscribe();
      };
    },
    onBindingChanged: () => ToolRegistry.notifyToolSelectionChanged(),
  });
}

let daemonBindingStore: SessionToolBindingStore | undefined;

/**
 * The daemon's one binding store for stateless servers (#4678). Its release
 * subscription is made once and lives with the process, so a release between two
 * requests still clears the keyed binding. The socket server calls `forget(key)`
 * when the connection behind a key goes away.
 */
export function daemonSessionToolBindingStore(): SessionToolBindingStore {
  daemonBindingStore ??= createReleaseSubscribedBindingStore();
  return daemonBindingStore;
}

installDaemonSessionBindingScopes(daemonSessionToolBindingStore);
