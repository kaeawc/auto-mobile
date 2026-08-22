import Foundation

/// Result of hierarchy extraction with hash comparison.
public enum HierarchyResult {
    /// New hierarchy extracted with different structural content.
    case changed(hierarchy: ViewHierarchy, hash: Int, extractionTimeMs: Int64)

    /// Hierarchy extracted but structure unchanged (animation only).
    case unchanged(hierarchy: ViewHierarchy, hash: Int, extractionTimeMs: Int64, skippedPollCount: Int)

    /// Failed to extract hierarchy.
    case error(message: String)
}

/// Protocol for hierarchy debouncing
public protocol HierarchyDebouncing {
    /// Start polling for changes
    func start()

    /// Stop polling for changes
    func stop()

    /// Whether the debouncer is currently running
    var isRunning: Bool { get }

    /// Perform an immediate extraction (bypasses debounce and animation mode)
    func extractNow()

    /// Perform an immediate extraction and wait for it to complete (blocking)
    func extractNowBlocking(skipFlowEmit: Bool) -> ViewHierarchy?

    /// Update the polling interval used for future hierarchy checks
    func updatePollIntervalMs(_ pollIntervalMs: Int64)

    /// Set callback for hierarchy results
    func setOnResult(_ callback: @escaping (HierarchyResult) -> Void)

    /// Set callback for each newly observed structural UI state, including debounced changes.
    func setOnTransition(_ callback: @escaping (ViewHierarchy) -> Void)

    /// Get the last extracted hierarchy without triggering a new extraction
    func getLastHierarchy() -> ViewHierarchy?

    /// Reset all state
    func reset()
}

/// Smart debouncer for view hierarchy extraction on iOS.
///
/// Uses structural hash comparison to detect when content actually changes vs. when only
/// bounds are changing during animations.
///
/// Key optimization: During animations, many UI updates fire but only bounds change.
/// By comparing structural hashes, we can:
/// - Detect animation mode: Same hash = skip broadcasting, continue polling
/// - Detect real changes: Different hash = content changed, broadcast
///
/// This reduces noise during animations while still detecting real changes quickly.
public class HierarchyDebouncer: HierarchyDebouncing {
    // MARK: - Configuration

    /// How often to poll for changes (default 1s)
    public static let defaultPollIntervalMs: Int64 = 1000

    /// How long to skip broadcasts after detecting animation (default 100ms)
    public static let animationSkipWindowMs: Int64 = 100

    /// Minimum interval between broadcasts (debounce)
    public static let broadcastDebounceMs: Int64 = 50

    /// Factor by which the poll interval grows on each consecutive idle poll
    /// (structure unchanged since the last broadcast). Backing off eliminates the
    /// steady-state idle load of a full hierarchy walk every second on a static
    /// screen (issue #5477).
    public static let idleBackoffMultiplier: Int64 = 2

    /// Cap on the idle backoff, as a multiple of the base poll interval — i.e. the
    /// interval progresses base -> 2x -> 4x and then holds (e.g. 1s -> 2s -> 4s).
    public static let maxIdleBackoffMultiplier: Int64 = 4

    // MARK: - Dependencies

    private let elementLocator: ElementLocating
    private let timer: Timer
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

    private let lock = NSLock()
    private var _isRunning = false
    private var pollScheduled = false
    private var pollGeneration = 0
    private var onResult: ((HierarchyResult) -> Void)?
    private var onTransition: ((ViewHierarchy) -> Void)?

    public var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isRunning
    }

    // MARK: - Init

    public init(
        elementLocator: ElementLocating,
        timer: Timer = SystemTimer(),
        pollIntervalMs: Int64 = HierarchyDebouncer.defaultPollIntervalMs
    ) {
        self.elementLocator = elementLocator
        self.timer = timer
        self.pollIntervalMs = pollIntervalMs
        effectivePollIntervalMs = pollIntervalMs
    }

    // MARK: - Public Interface

    public func setOnResult(_ callback: @escaping (HierarchyResult) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        onResult = callback
    }

    public func setOnTransition(_ callback: @escaping (ViewHierarchy) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        onTransition = callback
    }

    public func setPollIntervalMs(_ intervalMs: Int64) {
        lock.lock()
        pollIntervalMs = max(1, intervalMs)
        effectivePollIntervalMs = pollIntervalMs
        pollGeneration += 1
        let shouldReschedule = _isRunning
        pollScheduled = false
        lock.unlock()

        if shouldReschedule {
            scheduleNextPoll()
        }
    }

    public func start() {
        lock.lock()
        guard !_isRunning else {
            lock.unlock()
            return
        }
        _isRunning = true
        lock.unlock()

        // Capture initial state
        captureInitialState()

        // Schedule first poll
        scheduleNextPoll()
    }

    public func stop() {
        lock.lock()
        _isRunning = false
        pollScheduled = false
        pollGeneration += 1
        lock.unlock()
    }

    public func extractNow() {
        lock.lock()
        inAnimationMode = false
        lock.unlock()

        // Explicit command: reset the idle backoff and reschedule the next poll at
        // the fast base interval, cancelling any pending backed-off poll (#5477).
        resetPollCadence()

        extractAndCompare(skipBroadcast: false)
    }

    public func extractNowBlocking(skipFlowEmit: Bool = false) -> ViewHierarchy? {
        lock.lock()
        inAnimationMode = false
        lock.unlock()

        resetPollCadence()

        extractAndCompare(skipBroadcast: skipFlowEmit)

        lock.lock()
        let hierarchy = lastHierarchy
        lock.unlock()
        return hierarchy
    }

    public func updatePollIntervalMs(_ pollIntervalMs: Int64) {
        lock.lock()
        self.pollIntervalMs = pollIntervalMs
        effectivePollIntervalMs = pollIntervalMs
        pollGeneration += 1
        let running = _isRunning
        pollScheduled = false
        lock.unlock()

        if running {
            scheduleNextPoll()
        }
    }

    public func getLastHierarchy() -> ViewHierarchy? {
        lock.lock()
        defer { lock.unlock() }
        return lastHierarchy
    }

    public func reset() {
        lock.lock()
        lastStructuralHash = 0
        lastObservedStructuralHash = 0
        inAnimationMode = false
        animationModeEndTime = 0
        skippedPollCount = 0
        lastBroadcastTime = 0
        lastHierarchy = nil
        effectivePollIntervalMs = pollIntervalMs
        lock.unlock()
    }

    // MARK: - Private

    /// Reset the idle backoff to the fast base interval and, if running, cancel the
    /// pending (possibly backed-off) poll and schedule a fresh one at that interval.
    private func resetPollCadence() {
        lock.lock()
        effectivePollIntervalMs = pollIntervalMs
        let running = _isRunning
        pollGeneration += 1
        pollScheduled = false
        lock.unlock()

        if running {
            scheduleNextPoll()
        }
    }

    private func scheduleNextPoll() {
        lock.lock()
        guard _isRunning, !pollScheduled else {
            lock.unlock()
            return
        }
        pollScheduled = true
        let scheduledGeneration = pollGeneration
        let intervalMs = effectivePollIntervalMs
        lock.unlock()

        timer.schedule(after: intervalMs) { [weak self] in
            guard let self = self else { return }

            self.lock.lock()
            guard scheduledGeneration == self.pollGeneration else {
                self.lock.unlock()
                return
            }
            self.pollScheduled = false
            let shouldContinue = self._isRunning
            self.lock.unlock()

            if shouldContinue {
                self.pollAndCheck()
                self.scheduleNextPoll()
            }
        }
    }

    private func captureInitialState() {
        do {
            let startTime = timer.now()
            let hierarchy = try elementLocator.getViewHierarchy(disableAllFiltering: false)
            let extractionTime = timer.now() - startTime
            let hash = StructuralHasher.computeHash(hierarchy)

            lock.lock()
            lastStructuralHash = hash
            lastObservedStructuralHash = hash
            lastHierarchy = hierarchy
            lastBroadcastTime = timer.now()
            let callback = onResult
            lock.unlock()

            // Broadcast initial state so the IDE receives hierarchy immediately
            let result = HierarchyResult.changed(
                hierarchy: hierarchy,
                hash: hash,
                extractionTimeMs: extractionTime
            )
            print("[HierarchyDebouncer] Initial hierarchy broadcast hash=\(hash) extractionMs=\(extractionTime)")
            callback?(result)
        } catch {
            print("[HierarchyDebouncer] Failed to capture initial state: \(error)")
        }
    }

    private func pollAndCheck() {
        let now = timer.now()

        lock.lock()
        let running = _isRunning
        let animationMode = inAnimationMode
        let animationEnd = animationModeEndTime
        lock.unlock()

        guard running else { return }

        // If we're in animation mode and within the skip window, skip extraction
        if animationMode, now < animationEnd {
            lock.lock()
            skippedPollCount += 1
            lock.unlock()
            return
        }

        // Exit animation mode if window expired
        if animationMode, now >= animationEnd {
            lock.lock()
            inAnimationMode = false
            lock.unlock()
        }

        extractAndCompare(skipBroadcast: false)
    }

    private func extractAndCompare(skipBroadcast: Bool) {
        let startTime = timer.now()

        do {
            let hierarchy = try elementLocator.getViewHierarchy(disableAllFiltering: false)
            let extractionTime = timer.now() - startTime
            let newHash = StructuralHasher.computeHash(hierarchy)

            lock.lock()
            let oldHash = lastStructuralHash
            let oldObservedHash = lastObservedStructuralHash
            let callback = onResult
            let transitionCallback = onTransition
            let lastBroadcast = lastBroadcastTime
            lock.unlock()

            if newHash != oldObservedHash {
                lock.lock()
                lastObservedStructuralHash = newHash
                lock.unlock()
                transitionCallback?(hierarchy)
            }

            if newHash == oldHash {
                // Structure unchanged - likely animation
                lock.lock()
                inAnimationMode = true
                animationModeEndTime = timer.now() + HierarchyDebouncer.animationSkipWindowMs
                lastHierarchy = hierarchy
                // Idle: nothing changed since the last broadcast, so back off the
                // poll interval toward the cap to eliminate steady-state load.
                effectivePollIntervalMs = min(
                    effectivePollIntervalMs * HierarchyDebouncer.idleBackoffMultiplier,
                    pollIntervalMs * HierarchyDebouncer.maxIdleBackoffMultiplier
                )
                lock.unlock()

                // Don't broadcast unchanged results to reduce noise
                // Structure unchanged = animation mode, just reset counter
                lock.lock()
                skippedPollCount = 0
                lock.unlock()

            } else {
                // Structure changed - this is a real content change
                let now = timer.now()

                lock.lock()
                inAnimationMode = false
                lastHierarchy = hierarchy
                skippedPollCount = 0
                // A real change resets the cadence to the fast base interval so we
                // stay responsive immediately after any content change.
                effectivePollIntervalMs = pollIntervalMs
                lock.unlock()

                // Debounce broadcasts
                let timeSinceLastBroadcast = now - lastBroadcast
                let shouldBroadcast = !skipBroadcast && timeSinceLastBroadcast >= HierarchyDebouncer.broadcastDebounceMs

                if shouldBroadcast {
                    // Only update the structural hash when we actually broadcast.
                    // This ensures that if a change is debounced, the next poll will
                    // re-detect it and broadcast once the debounce window has passed.
                    // Without this, the last change in a rapid sequence can be silently
                    // dropped (hash updated but never broadcast).
                    lock.lock()
                    lastStructuralHash = newHash
                    lastBroadcastTime = now
                    lock.unlock()

                    let result = HierarchyResult.changed(
                        hierarchy: hierarchy,
                        hash: newHash,
                        extractionTimeMs: extractionTime
                    )

                    print(
                        "[HierarchyDebouncer] Hierarchy changed oldHash=\(oldHash) newHash=\(newHash) extractionMs=\(extractionTime)"
                    )
                    callback?(result)
                }
            }
        } catch {
            // Log errors during polling for debuggability
            // This can happen if the app is transitioning between states
            print("[HierarchyDebouncer] Extraction error: \(error)")
        }
    }
}

// MARK: - Structural Hasher

/// Computes a structural hash of a ViewHierarchy for change detection.
/// Ignores bounds to focus on content changes vs. animation changes.
public enum StructuralHasher {
    /// Compute a structural hash of the hierarchy.
    /// Ignores bounds to differentiate content changes from animation/scroll changes.
    public static func computeHash(_ hierarchy: ViewHierarchy) -> Int {
        var hasher = Hasher()

        // Include package name
        if let packageName = hierarchy.packageName {
            hasher.combine(packageName)
        }

        // Include hierarchy structure (but not bounds)
        if let root = hierarchy.hierarchy {
            hashElement(root, into: &hasher, depth: 0, maxDepth: 15)
        }

        return hasher.finalize()
    }

    private static func hashElement(_ element: UIElementInfo, into hasher: inout Hasher, depth: Int, maxDepth: Int) {
        // Hash all identifying & state properties (NOT bounds/textSize - those change during animations)
        hasher.combine(element.text)
        hasher.combine(element.contentDesc)
        hasher.combine(element.resourceId)
        hasher.combine(element.className)
        hasher.combine(element.role)
        hasher.combine(element.testTag)
        hasher.combine(element.hintText)
        hasher.combine(element.stateDescription)
        hasher.combine(element.errorMessage)

        // Hash interactive/state properties
        hasher.combine(element.clickable)
        hasher.combine(element.enabled)
        hasher.combine(element.focusable)
        hasher.combine(element.focused)
        hasher.combine(element.accessibilityFocused)
        hasher.combine(element.scrollable)
        hasher.combine(element.password)
        hasher.combine(element.checkable)
        hasher.combine(element.checked)
        hasher.combine(element.selected)
        hasher.combine(element.longClickable)

        // Hash available actions
        if let actions = element.actions {
            hasher.combine(actions)
        }

        // Hash children recursively (up to maxDepth)
        if depth < maxDepth, let children = element.node {
            hasher.combine(children.count)
            for child in children {
                hashElement(child, into: &hasher, depth: depth + 1, maxDepth: maxDepth)
            }
        }
    }
}

// MARK: - Fake for Testing

/// Fake implementation for testing hierarchy debouncing
public class FakeHierarchyDebouncer: HierarchyDebouncing {
    // Call tracking
    public private(set) var startCallCount = 0
    public private(set) var stopCallCount = 0
    public private(set) var extractNowCallCount = 0
    public private(set) var extractNowBlockingCallCount = 0
    public private(set) var updatePollIntervalMsCallCount = 0
    public private(set) var setOnResultCallCount = 0
    public private(set) var resetCallCount = 0

    // State
    private var _isRunning = false
    private var onResult: ((HierarchyResult) -> Void)?
    private var onTransition: ((ViewHierarchy) -> Void)?
    private var lastHierarchy: ViewHierarchy?
    private let lock = NSLock()

    /// Configure what hierarchy to return from extractNowBlocking
    public var hierarchyToReturn: ViewHierarchy?
    public private(set) var lastPollIntervalMs: Int64?

    public var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isRunning
    }

    public init() {}

    public func start() {
        lock.lock()
        startCallCount += 1
        _isRunning = true
        lock.unlock()
    }

    public func stop() {
        lock.lock()
        stopCallCount += 1
        _isRunning = false
        lock.unlock()
    }

    public func extractNow() {
        lock.lock()
        extractNowCallCount += 1
        lock.unlock()
    }

    public func extractNowBlocking(skipFlowEmit _: Bool = false) -> ViewHierarchy? {
        lock.lock()
        extractNowBlockingCallCount += 1
        let hierarchy = hierarchyToReturn
        lastHierarchy = hierarchy
        lock.unlock()
        return hierarchy
    }

    public func updatePollIntervalMs(_ pollIntervalMs: Int64) {
        lock.lock()
        updatePollIntervalMsCallCount += 1
        lastPollIntervalMs = pollIntervalMs
        lock.unlock()
    }

    public func setOnResult(_ callback: @escaping (HierarchyResult) -> Void) {
        lock.lock()
        setOnResultCallCount += 1
        onResult = callback
        lock.unlock()
    }

    public func setOnTransition(_ callback: @escaping (ViewHierarchy) -> Void) {
        lock.lock()
        onTransition = callback
        lock.unlock()
    }

    public func getLastHierarchy() -> ViewHierarchy? {
        lock.lock()
        defer { lock.unlock() }
        return lastHierarchy
    }

    public func reset() {
        lock.lock()
        resetCallCount += 1
        lastHierarchy = nil
        lock.unlock()
    }

    /// Simulate a hierarchy change for testing
    public func simulateChange(_ result: HierarchyResult) {
        lock.lock()
        let callback = onResult
        if case let .changed(hierarchy, _, _) = result {
            lastHierarchy = hierarchy
        } else if case let .unchanged(hierarchy, _, _, _) = result {
            lastHierarchy = hierarchy
        }
        lock.unlock()
        callback?(result)
        if case let .changed(hierarchy, _, _) = result {
            onTransition?(hierarchy)
        }
    }

    /// Reset all call counts for fresh test assertions
    public func resetCounts() {
        lock.lock()
        startCallCount = 0
        stopCallCount = 0
        extractNowCallCount = 0
        extractNowBlockingCallCount = 0
        updatePollIntervalMsCallCount = 0
        setOnResultCallCount = 0
        resetCallCount = 0
        lastPollIntervalMs = nil
        lock.unlock()
    }
}
