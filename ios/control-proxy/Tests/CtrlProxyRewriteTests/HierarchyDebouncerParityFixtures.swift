import Foundation

// Module-agnostic fixtures for the `HierarchyDebouncer` differential parity harness.
// This file imports NEITHER module: it defines the scripted-scenario vocabulary and the
// module-agnostic observation types that `ReferenceHierarchyDebouncer` and
// `RewriteHierarchyDebouncer` each translate into their own module's `HierarchyDebouncer`
// + fakes. The parity test then diffs the two `DebouncerRun`s.

/// One scripted action driven against a debouncer. `setHierarchy` carries a JSON
/// `ViewHierarchy` (decoded by each driver into its module's model — the same
/// JSON-decode seam `FrameContextParityTests` uses), so the vocabulary never names
/// either module's types.
enum DebouncerStep: Sendable {
    /// Configure the extractor to return this hierarchy (JSON) on subsequent reads.
    case setHierarchy(Data)
    /// Configure the extractor to throw (`true`) or stop throwing (`false`).
    case setThrow(Bool)
    /// `start()` — captures + broadcasts the initial state, then schedules polling.
    case start
    /// `stop()` — halts polling and invalidates any pending poll.
    case stop
    /// Advance the (manual) timer by N ms, firing any due poll callbacks in order.
    case advance(Int64)
    /// `updatePollIntervalMs(_:)` — the production cadence-reset path (bumps the poll
    /// generation, resets the idle backoff, reschedules at the new base interval).
    case updatePollInterval(Int64)
}

/// A named scripted scenario plus the base poll interval the debouncer starts with.
struct DebouncerScenario: Sendable {
    let name: String
    let pollIntervalMs: Int64
    let steps: [DebouncerStep]
}

/// A module-agnostic observation emitted by a debouncer during a run, in call order.
/// `extractionTimeMs` is deliberately excluded — it is wall-clock-derived and not part
/// of the behavioral contract. Structural hashes ARE compared: within one test process
/// Swift's per-process `Hasher` seed is fixed, so both modules' `StructuralHasher`
/// produce identical `Int`s for equivalent hierarchies (already relied on by the
/// hierarchy/`FrameContext` parity suites).
enum DebouncerEvent: Equatable, Sendable {
    /// `onTransition` fired for a newly observed structural state (carries its hash).
    case transition(hash: Int)
    /// `onResult(.changed)` broadcast (carries the broadcast hash).
    case changed(hash: Int)
}

/// The full observable outcome of a scenario: the ordered event stream, the timer time
/// at each SUCCESSFUL extraction (captures poll cadence + backoff), and the total
/// extraction count (incremented even on a throwing poll, so error-path polling shows).
struct DebouncerRun: Equatable, Sendable {
    var events: [DebouncerEvent]
    var readTimes: [Int64]
    var extractionCount: Int
}

/// Reference-type accumulator shared by both drivers (each run gets its own instance).
/// Non-`Sendable` and touched only synchronously on the main actor within a single
/// `run`, so plain mutable fields are safe.
final class DebouncerRecorder {
    var events: [DebouncerEvent] = []
    var readTimes: [Int64] = []
}

/// Error a driver's fake throws for a `.setThrow(true)` step. The debouncer swallows
/// extraction errors (logs + retries), so the concrete type is irrelevant to parity.
struct DebouncerFakeError: Error {}

/// Builds a valid `ViewHierarchy` JSON blob. `buttonText` drives the structural hash
/// (a different text → different hash); `boundsOffset` shifts only the button bounds,
/// which the `StructuralHasher` ignores — so two blobs that differ only in
/// `boundsOffset` hash identically (the "animation, not a real change" case).
func debouncerHierarchyJSON(buttonText: String, boundsOffset: Int = 0) -> Data {
    let left = 10 + boundsOffset
    let json = """
    {
      "updatedAt": 1,
      "packageName": "com.example.app",
      "hierarchy": {
        "className": "Window",
        "bounds": { "left": 0, "top": 0, "right": 393, "bottom": 852 },
        "node": [
          {
            "className": "Button",
            "text": "\(buttonText)",
            "resource-id": "primary_button",
            "clickable": "true",
            "bounds": { "left": \(left), "top": 20, "right": \(left + 110), "bottom": 64 }
          }
        ]
      },
      "insets": {
        "available": true,
        "source": "safeAreaInsets",
        "units": "points",
        "safeArea": { "top": 59, "right": 0, "bottom": 34, "left": 0 },
        "systemChrome": {
          "visibility": "visible",
          "statusBar": "shown",
          "homeIndicatorAutoHideRequested": false,
          "source": "scene"
        }
      }
    }
    """
    return Data(json.utf8)
}

/// The scripted scenarios exercised by `HierarchyDebouncerParityTests`. Each is driven
/// through BOTH modules and the resulting `DebouncerRun`s must be identical. Together
/// they cover: initial broadcast, structural change, transition-before-broadcast,
/// animation (same-hash-different-bounds → no broadcast), debounce, idle backoff
/// (base → 2x → 4x cap), reset-to-fast-on-change, generation-based cancellation via
/// `updatePollIntervalMs`, extraction-error recovery, stop, cadence change, and the
/// animation skip window.
enum DebouncerScenarios {
    static let all: [DebouncerScenario] = [
        initialChangeThenAnimation,
        debouncedChangeEventuallyBroadcast,
        idleBackoffToCap,
        resetsToFastIntervalOnChange,
        updatePollIntervalResetsCadence,
        continuesPollingAfterError,
        stopPreventsPolling,
        updatePollIntervalChangesCadence,
        animationSkipWindow,
    ]

    private static var a: Data { debouncerHierarchyJSON(buttonText: "OK") }
    private static var b: Data { debouncerHierarchyJSON(buttonText: "Cancel") }
    private static var bAnim: Data { debouncerHierarchyJSON(buttonText: "Cancel", boundsOffset: 5) }

    /// Initial broadcast, then a structural change (transition + changed), then an
    /// animation-only frame (same structure, shifted bounds) that must NOT broadcast.
    private static var initialChangeThenAnimation: DebouncerScenario {
        DebouncerScenario(name: "initialChangeThenAnimation", pollIntervalMs: 1000, steps: [
            .setHierarchy(a), .start,
            .setHierarchy(b), .advance(1000),      // t=1000: transition + changed
            .setHierarchy(bAnim), .advance(1000),  // t=2000: same hash → no broadcast
        ])
    }

    /// A change detected inside the 50ms debounce window fires `transition` once but is
    /// not broadcast until the window elapses. Base interval 10ms < debounce 50ms.
    private static var debouncedChangeEventuallyBroadcast: DebouncerScenario {
        DebouncerScenario(name: "debouncedChangeEventuallyBroadcast", pollIntervalMs: 10, steps: [
            .setHierarchy(a), .start,
            .setHierarchy(b),
            .advance(10),   // t=10: transition(B), debounced (10 < 50)
            .advance(10),   // t=20: still debounced
            .advance(10),   // t=30
            .advance(10),   // t=40
            .advance(10),   // t=50: window elapsed → changed(B) broadcast
        ])
    }

    /// Static screen: each idle poll backs the interval off 200 → 400 → 800(cap) → 800,
    /// so polls land at t = 200, 600, 1400, 2200. Only the initial state broadcasts.
    private static var idleBackoffToCap: DebouncerScenario {
        DebouncerScenario(name: "idleBackoffToCap", pollIntervalMs: 200, steps: [
            .setHierarchy(a), .start,
            .advance(200),   // t=200  → backoff 400
            .advance(400),   // t=600  → backoff 800 (cap)
            .advance(800),   // t=1400 → holds at 800
            .advance(800),   // t=2200 → holds at 800
        ])
    }

    /// After backing off, a real structural change resets the cadence to the fast base
    /// interval (the poll following the change lands one base-interval later).
    private static var resetsToFastIntervalOnChange: DebouncerScenario {
        DebouncerScenario(name: "resetsToFastIntervalOnChange", pollIntervalMs: 200, steps: [
            .setHierarchy(a), .start,
            .advance(200),   // t=200  idle → backoff 400
            .advance(400),   // t=600  idle → backoff 800
            .setHierarchy(b),
            .advance(800),   // t=1400 change → resets to 200
            .advance(200),   // t=1600 idle at fast interval (proves reset)
        ])
    }

    /// `updatePollIntervalMs` bumps the poll generation, so the pending backed-off poll
    /// is cancelled (fires stale → no-op) and polling restarts at the base interval.
    private static var updatePollIntervalResetsCadence: DebouncerScenario {
        DebouncerScenario(name: "updatePollIntervalResetsCadence", pollIntervalMs: 200, steps: [
            .setHierarchy(a), .start,
            .advance(200),              // t=200 idle → backoff 400, stale poll pending @600
            .updatePollInterval(200),   // reset: gen++, reschedule @400
            .advance(200),              // t=400 poll (fresh gen)
            .advance(200),              // t=600 stale poll fires → no-op (no read)
            .advance(200),              // t=800 poll (fresh gen)
        ])
    }

    /// A throwing poll is swallowed (no event, no read) and polling continues: the next
    /// successful poll detects and broadcasts the change.
    private static var continuesPollingAfterError: DebouncerScenario {
        DebouncerScenario(name: "continuesPollingAfterError", pollIntervalMs: 200, steps: [
            .setHierarchy(a), .start,
            .setThrow(true), .advance(200),                    // t=200 throws → no event
            .setThrow(false), .setHierarchy(b), .advance(200), // t=400 recovers → change
        ])
    }

    /// After `stop()`, the pending poll is invalidated and a later timer advance drives
    /// no extraction.
    private static var stopPreventsPolling: DebouncerScenario {
        DebouncerScenario(name: "stopPreventsPolling", pollIntervalMs: 200, steps: [
            .setHierarchy(a), .start, .stop,
            .setHierarchy(b), .advance(400), // no poll: debouncer stopped
        ])
    }

    /// `updatePollIntervalMs` while running switches cadence: a poll lands at the new
    /// (shorter) interval, not the original one.
    private static var updatePollIntervalChangesCadence: DebouncerScenario {
        DebouncerScenario(name: "updatePollIntervalChangesCadence", pollIntervalMs: 1000, steps: [
            .setHierarchy(a), .start,
            .updatePollInterval(200),
            .setHierarchy(b), .advance(200), // t=200 poll at new cadence → change
        ])
    }

    /// A poll that lands inside the 100ms post-animation skip window is skipped (no
    /// extraction); the following poll, past the window, extracts. Base 40ms.
    private static var animationSkipWindow: DebouncerScenario {
        DebouncerScenario(name: "animationSkipWindow", pollIntervalMs: 40, steps: [
            .setHierarchy(a), .start,
            .advance(40),   // t=40  idle → animation mode (window ends t=140), backoff 80
            .advance(80),   // t=120 inside window (<140) → SKIPPED, no read
            .advance(80),   // t=200 past window → extracts
        ])
    }
}
