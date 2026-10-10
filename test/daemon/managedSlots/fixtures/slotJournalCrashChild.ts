/**
 * Child-process half of the journal restart test (#11179). Opens the slot registry file, then
 * reconciles slot 0 to a new spec and stops dead at the requested crash point (it writes a marker
 * file and hangs there until the parent SIGKILLs it).
 */
import {
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
  processJournalOwner,
} from "../../../../src/daemon/managedSlots/reconciler";
import { openSqliteSlotRegistry } from "../../../../src/daemon/managedSlots/sqliteSlotRegistry";
import type { SlotScopeIdentity } from "../../../../src/daemon/managedSlots/slotRegistry";
import type { ExactDeviceSpecification } from "../../../../src/devices/exactDeviceProvisioning";
import { defaultTimer } from "../../../../src/utils/SystemTimer";
import {
  FileDeleter,
  FileDeviceState,
  FileInventory,
  FileProvisioner,
  parseCrashPoint,
} from "./fileDevicePorts";
import { FakeClaims, FakeMatcher } from "./reconcilerFakes";

const [dbPath, statePath, markerPath, crashArg, identityJson, specJson] = process.argv.slice(2);
const identity: SlotScopeIdentity = JSON.parse(identityJson);
const spec: ExactDeviceSpecification = JSON.parse(specJson);
const crash = parseCrashPoint(crashArg);

const registry = await openSqliteSlotRegistry({ dbPath });
const scope = await registry.ensureScope(identity);
if (scope.kind !== "ready") {
  throw new Error(`child scope not ready: ${scope.kind}`);
}
const state = new FileDeviceState(statePath);
const reconciler = new ManagedSlotReconciler({
  registry,
  inventory: new FileInventory(state),
  matcher: new FakeMatcher(),
  resolver: new DefaultManagedSpecResolver(),
  provisioner: new FileProvisioner(state, crash, markerPath),
  deleter: new FileDeleter(state, crash, markerPath),
  claims: new FakeClaims(),
  timer: defaultTimer,
  journal: { owner: { ...processJournalOwner(), daemonId: "child-daemon" } },
});
await reconciler.reconcile({
  key: { scopeKey: scope.scope.scopeKey, slotIndex: 0 },
  role: "app",
  platform: "ios",
  requestedSpec: spec,
  deadlineMs: Date.now() + 60_000,
});
// Reaching here means the crash point was never hit.
process.exit(3);
