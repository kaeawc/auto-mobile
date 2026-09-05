import Foundation

/// Smart debouncer for view-hierarchy extraction on iOS. Ported from the reference
/// `HierarchyDebouncer`.
///
/// Uses structural-hash comparison to distinguish real content changes from
/// bounds-only churn during animations:
/// - Same hash as last broadcast = animation → skip broadcasting, back off the poll
///   interval toward the cap to eliminate steady-state idle load (issue #5477).
/// - Different hash = real change → reset to the fast interval and broadcast (debounced).
///
/// Rewrite archetype: `@MainActor`. The reference was a plain `class` guarding every
/// field with an `NSLock`; view-hierarchy extraction is inherently main-thread work, so
/// the rewrite isolates the whole state machine to the main actor and drops the lock
/// entirely. The injected `ProxyTimer` fires its callback on the main thread
/// (`SystemTimer` dispatches to `DispatchQueue.main`; the test `FakeTimer` fires
/// synchronously on the advancing thread, which the tests keep on the main actor), so
/// the `@Sendable` timer callback re-enters main-actor isolation via
/// `MainActor.assumeIsolated` — a synchronous hop that preserves the reference's
/// extract → compare → broadcast ordering exactly (no `Task { @MainActor }` reordering).
///
/// The reference's `pollGeneration` / `pollScheduled` stale-cancellation is retained:
/// the timer keeps already-scheduled callbacks queued, so bumping the generation on any
/// cadence change (stop / `updatePollIntervalMs`) invalidates a stale callback when it
/// finally fires.
///
/// Surface trimmed to production callers (YAGNI): `extractNow` /
/// `extractNowBlocking` / `reset` / `setPollIntervalMs` and the public `isRunning`
/// getter had no callers in the reference app and are dropped. The
/// `HierarchyDebouncing` protocol and its fake are deferred to Phase 6, where the
/// production wiring lands.
@MainActor
final class HierarchyDebouncer: HierarchyDebouncing {
    // MARK: - Configuration

    /// How often to poll for changes (default 1s).
    static let defaultPollIntervalMs: Int64 = 1000

    /// How long to skip broadcasts after detecting animation (default 100ms).
    static let animationSkipWindowMs: Int64 = 100

    /// Minimum interval between broadcasts (debounce).
    static let broadcastDebounceMs: Int64 = 50

    /// Factor by which the poll interval grows on each consecutive idle poll
    /// (structure unchanged since the last broadcast). Backing off eliminates the
    /// steady-state idle load of a full hierarchy walk every second on a static
    /// screen (issue #5477).
    static let idleBackoffMultiplier: Int64 = 2

    /// Cap on the idle backoff, as a multiple of the base poll interval — i.e. the
    /// interval progresses base -> 2x -> 4x and then holds (e.g. 1s -> 2s -> 4s).
    static let maxIdleBackoffMultiplier: Int64 = 4

    // MARK: - Dependencies

    private let hierarchyExtractor: any HierarchyExtracting
    /// Perf tracker used to bind a fresh scope around each background extraction, so the
    /// instrumented `getViewHierarchy` roots reach `PerfProvider`'s shared pool and are
    /// reported by the next response's flush (the reference's relied-on pooled-flush of
    /// background hierarchy timings).
    private let perf: any PerfTracking
    private let timer: any ProxyTimer
    /// Base (fast) poll interval; the interval used immediately after any change.
    private var pollIntervalMs: Int64
    /// Effective interval for the next scheduled poll, grown while idle up to the
    /// backoff cap and reset to `pollIntervalMs` on any change or explicit command.
    private var effectivePollIntervalMs: Int64

    // MARK: - State

    private var lastStructuralHash = 0
    private var lastObservedStructuralHash = 0
    private var inAnimationMode = false
    private var animationModeEndTime: Int64 = 0
    private var skippedPollCount = 0
    private var lastBroadcastTime: Int64 = 0
    private var lastHierarchy: ViewHierarchy?

    private var isRunning = false
    private var pollScheduled = false
    private var pollGeneration = 0
    private var onResult: ((HierarchyResult) -> Void)?
    private var onTransition: ((ViewHierarchy) -> Void)?

    // MARK: - Init

    init(
        hierarchyExtractor: any HierarchyExtracting,
        perf: any PerfTracking,
        timer: any ProxyTimer = SystemTimer(),
        pollIntervalMs: Int64 = HierarchyDebouncer.defaultPollIntervalMs
    ) {
        self.hierarchyExtractor = hierarchyExtractor
        self.perf = perf
        self.timer = timer
        self.pollIntervalMs = pollIntervalMs
        effectivePollIntervalMs = pollIntervalMs
    }

    // MARK: - Public Interface

    func setOnResult(_ callback: @escaping (HierarchyResult) -> Void) {
        onResult = callback
    }

    /// Set callback for each newly observed structural UI state, including debounced changes.
    func setOnTransition(_ callback: @escaping (ViewHierarchy) -> Void) {
        onTransition = callback
    }

    func start() {
        guard !isRunning else { return }
        isRunning = true

        // Capture initial state and broadcast it, then schedule the first poll.
        captureInitialState()
        scheduleNextPoll()
    }

    func stop() {
        isRunning = false
        pollScheduled = false
        // Invalidate any already-scheduled poll so it no-ops when it fires.
        pollGeneration += 1
    }

    /// Update the polling interval used for future hierarchy checks. Resets the idle
    /// backoff to the new base and, if running, cancels the pending (possibly
    /// backed-off) poll and schedules a fresh one at that interval.
    func updatePollIntervalMs(_ pollIntervalMs: Int64) {
        self.pollIntervalMs = pollIntervalMs
        effectivePollIntervalMs = pollIntervalMs
        pollGeneration += 1
        pollScheduled = false

        if isRunning {
            scheduleNextPoll()
        }
    }

    /// Get the last extracted hierarchy without triggering a new extraction.
    func getLastHierarchy() -> ViewHierarchy? {
        lastHierarchy
    }

    // MARK: - Private

    private func scheduleNextPoll() {
        guard isRunning, !pollScheduled else { return }
        pollScheduled = true
        let scheduledGeneration = pollGeneration
        let intervalMs = effectivePollIntervalMs

        timer.schedule(after: intervalMs) { [weak self] in
            guard let self else { return }
            // The timer contractually fires on the main thread, so re-enter main-actor
            // isolation synchronously to touch the isolated state.
            MainActor.assumeIsolated {
                guard scheduledGeneration == self.pollGeneration else { return }
                self.pollScheduled = false
                guard self.isRunning else { return }
                self.pollAndCheck()
                self.scheduleNextPoll()
            }
        }
    }

    private func captureInitialState() {
        do {
            let startTime = timer.now()
            // Bind a fresh perf scope so the instrumented extraction's completed root lands in
            // the shared pool; the reference relied on this pooled flush of background hierarchy
            // timings into the next response's perfTiming (without a scope the perf calls no-op).
            let hierarchy = try perf.withScope {
                try hierarchyExtractor.getViewHierarchy(disableAllFiltering: false)
            }
            let extractionTime = timer.now() - startTime
            let hash = StructuralHasher.computeHash(hierarchy)

            lastStructuralHash = hash
            lastObservedStructuralHash = hash
            lastHierarchy = hierarchy
            lastBroadcastTime = timer.now()

            // Broadcast initial state so the IDE receives hierarchy immediately.
            let result = HierarchyResult.changed(
                hierarchy: hierarchy,
                hash: hash,
                extractionTimeMs: extractionTime
            )
            print("[HierarchyDebouncer] Initial hierarchy broadcast hash=\(hash) extractionMs=\(extractionTime)")
            onResult?(result)
        } catch {
            print("[HierarchyDebouncer] Failed to capture initial state: \(error)")
        }
    }

    private func pollAndCheck() {
        let now = timer.now()

        guard isRunning else { return }

        // If we're in animation mode and within the skip window, skip extraction.
        if inAnimationMode, now < animationModeEndTime {
            skippedPollCount += 1
            return
        }

        // Exit animation mode if the window expired.
        if inAnimationMode, now >= animationModeEndTime {
            inAnimationMode = false
        }

        extractAndCompare()
    }

    private func extractAndCompare() {
        let startTime = timer.now()

        do {
            // Bind a fresh perf scope so the instrumented extraction's completed root is pooled
            // for the next response's perfTiming (see captureInitialState) instead of no-oping
            // outside any scope.
            let hierarchy = try perf.withScope {
                try hierarchyExtractor.getViewHierarchy(disableAllFiltering: false)
            }
            let extractionTime = timer.now() - startTime
            let newHash = StructuralHasher.computeHash(hierarchy)

            let oldHash = lastStructuralHash
            let oldObservedHash = lastObservedStructuralHash

            if newHash != oldObservedHash {
                lastObservedStructuralHash = newHash
                onTransition?(hierarchy)
            }

            if newHash == oldHash {
                // Structure unchanged - likely animation.
                inAnimationMode = true
                animationModeEndTime = timer.now() + Self.animationSkipWindowMs
                lastHierarchy = hierarchy
                // Idle: nothing changed since the last broadcast, so back off the poll
                // interval toward the cap to eliminate steady-state load.
                effectivePollIntervalMs = min(
                    effectivePollIntervalMs * Self.idleBackoffMultiplier,
                    pollIntervalMs * Self.maxIdleBackoffMultiplier
                )
                // Don't broadcast unchanged results (animation mode); just reset the counter.
                skippedPollCount = 0
            } else {
                // Structure changed - this is a real content change.
                let now = timer.now()
                inAnimationMode = false
                lastHierarchy = hierarchy
                skippedPollCount = 0
                // A real change resets the cadence to the fast base interval so we stay
                // responsive immediately after any content change.
                effectivePollIntervalMs = pollIntervalMs

                // Debounce broadcasts.
                let timeSinceLastBroadcast = now - lastBroadcastTime
                let shouldBroadcast = timeSinceLastBroadcast >= Self.broadcastDebounceMs

                if shouldBroadcast {
                    // Only update the structural hash when we actually broadcast. This
                    // ensures that if a change is debounced, the next poll re-detects it
                    // and broadcasts once the debounce window has passed. Without this,
                    // the last change in a rapid sequence can be silently dropped (hash
                    // updated but never broadcast).
                    lastStructuralHash = newHash
                    lastBroadcastTime = now

                    let result = HierarchyResult.changed(
                        hierarchy: hierarchy,
                        hash: newHash,
                        extractionTimeMs: extractionTime
                    )
                    print(
                        "[HierarchyDebouncer] Hierarchy changed oldHash=\(oldHash) newHash=\(newHash) extractionMs=\(extractionTime)"
                    )
                    onResult?(result)
                }
            }
        } catch {
            // Log errors during polling for debuggability. This can happen if the app is
            // transitioning between states; the next poll retries.
            print("[HierarchyDebouncer] Extraction error: \(error)")
        }
    }
}
