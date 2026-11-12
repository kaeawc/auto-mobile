# Prototype user-test sessions

`prototype` actions `testSessionBegin {id, goal?, cohort?}`, `testSessionEnd {id}` and
`testSessionReport {id?, testSessionId?}` operate on the host without device requests
or device ownership acquisition. Begin allows one active recording per device and
prototype; routing session ownership scopes recorded events and latest-session lookup.
An explicit test-session id reads that stored session across routing sessions and
devices, so reports remain accessible after release or reconnect.
Cohort is metadata, without cross-session aggregation. A goal is a screen label;
completion remains true once reached, even if the user navigates away.

The coordinator records only events accepted by its sequence buffer, independently
of event consumption. The recorder sanitizes synchronously and serializes database
writes, begin/end and reports on one promise chain. Failures are logged and do not
interrupt device event delivery. End flushes earlier writes. Every step is stamped with
the host's receive time, never the device's event timestamp, because a physical device
clock can be skewed from the host's. A daemon
restart does not resume event recording: stored sessions remain reportable, and a begin
for the same device/id ends any active row this daemon does not record (reason `released`).
Events are recorded only for a prototype shown under the beginning call's session scope.

SQLite tables `prototype_test_sessions` and `prototype_test_session_steps` retain
session metadata and ordered sanitized steps. At most 5,000 steps are stored per
session; extra steps increment `dropped_count`. Pruning keeps the 50 newest ended
sessions per device/prototype and deletes their events with them. Active sessions
are retained. A truncated report describes retained events; later navigation and
goal arrivals may be absent, so completion and abandonment can be incomplete.

No state snapshots, text values, context, arbitrary payloads or data-write values
are stored. Input changes keep non-secure keys, string lengths or scalar types and
validity. Secure fields are omitted, including keys in validation failures. The
spec walker covers components, repeated templates and slots. Unresolved secure
keys or an unavailable spec suppress all field keys conservatively. Data writes
keep only path and operation; other authored emits keep their name.

Screen labels select the deepest stack path's top screen, ties by lexicographic
stack id, or `(root)` without stacks. Reports count visits and exits in first-visit
order; all events' own stack snapshots determine the current screen. Time starts
at session begin and moves at step receive times, clamped monotonically to the
session boundary. The final visit ends at end/dismissal, or report time while
active. An ended session that has not reached its goal is abandoned at its final
screen, unless the daemon ended it (`released`); an unset goal reports completion as null.

`window.deadTaps: true` requires `prototype_dead_tap_v1`; show refuses older agents
before mutation. The reserved `prototype_` emit namespace prevents authored events
from impersonating dead taps. Validated dead-tap coordinates are window-local dp
(points on iOS), rounded by the agent to one decimal. Reports retain up to 200
points per screen and count every retained tap in a 48-unit grid. Android measures from the prototype's own window; iOS measures from the agent window, which
fills the scene, so non-fullscreen iOS placements are offset by the placement origin (not
device-verified). Screenshot heatmap overlays are not implemented. `testSession.deadTaps` reflects the current
shown spec; absent or forgotten specs report off, including after dismissal.
