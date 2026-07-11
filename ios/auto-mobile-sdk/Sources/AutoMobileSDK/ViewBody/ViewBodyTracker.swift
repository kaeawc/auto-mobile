import Foundation
import SwiftUI

/// Tracks SwiftUI view body evaluations.
/// iOS equivalent of Android's RecompositionTracker for Compose.
public final class ViewBodyTracker: @unchecked Sendable {
    public static let shared = ViewBodyTracker()

    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    private var _isEnabled = false
    private var buffer: SdkEventBuffer?
    private var snapshotTimer: (any TimerScheduling)?
    private let snapshotIntervalMs: Int = 1000
    private var dateProvider: DateProvider = SystemDateProvider()

    /// Upper bound on tracked entries. Apps may use per-instance ids (e.g.
    /// `trackViewBody(id: item.uuid)` over a long/paginated feed), which would
    /// otherwise grow `entries` without bound for the life of the process
    /// (issue #3624). When the cap is exceeded we evict the least-recently-updated
    /// entries in a batch so the O(n) eviction scan is amortized across inserts.
    private let maxEntries = 512
    private let evictionBatch = 64

    private init() {}

    func initialize(buffer: SdkEventBuffer, dateProvider: DateProvider = SystemDateProvider()) {
        lock.lock()
        self.buffer = buffer
        self.dateProvider = dateProvider
        lock.unlock()
    }

    /// Whether tracking is enabled.
    public var isEnabled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isEnabled
    }

    /// Enable or disable tracking.
    public func setEnabled(_ enabled: Bool) {
        setEnabled(enabled, timerFactory: nil)
    }

    /// Enable or disable tracking with an injectable timer factory (internal for testing).
    func setEnabled(_ enabled: Bool, timerFactory: (() -> any TimerScheduling)?) {
        lock.lock()
        _isEnabled = enabled

        if enabled && snapshotTimer == nil {
            let timer = timerFactory?() ?? GCDTimer()
            snapshotTimer = timer
            lock.unlock()
            timer.schedule(intervalMs: snapshotIntervalMs) { [weak self] in
                self?.broadcastSnapshot()
            }
        } else if !enabled {
            snapshotTimer?.cancel()
            snapshotTimer = nil
            lock.unlock()
        } else {
            lock.unlock()
        }
    }

    /// Record a view body evaluation.
    public func recordBodyEvaluation(
        id: String,
        viewName: String? = nil
    ) {
        guard isEnabled else { return }

        lock.lock()
        let entry = entries[id] ?? Entry(id: id, viewName: viewName)
        var updated = entry
        updated.totalCount += 1
        let now = dateProvider.now().timeIntervalSince1970
        updated.lastUpdated = now
        updated.recentTimestamps.append(now)
        // Keep only timestamps from the last second for rolling average
        let cutoff = now - 1.0
        updated.recentTimestamps.removeAll { $0 < cutoff }
        entries[id] = updated
        enforceEntryCapLocked()
        lock.unlock()
    }

    /// Evict least-recently-updated entries once the cap is exceeded, down to a
    /// low-water mark so this scan runs at most once per `evictionBatch` inserts.
    /// Must be called with `lock` held.
    private func enforceEntryCapLocked() {
        guard entries.count > maxEntries else { return }
        let target = maxEntries - evictionBatch
        let removeCount = entries.count - target
        let oldestKeys = entries
            .sorted { $0.value.lastUpdated < $1.value.lastUpdated }
            .prefix(removeCount)
            .map { $0.key }
        for key in oldestKeys {
            entries.removeValue(forKey: key)
        }
    }

    /// Record composition duration for a view.
    public func recordDuration(id: String, durationMs: Double) {
        guard isEnabled else { return }

        lock.lock()
        guard var entry = entries[id] else {
            lock.unlock()
            return
        }
        entry.totalDurationMs += durationMs
        entry.durationCount += 1
        entries[id] = entry
        lock.unlock()
    }

    /// Get current snapshots.
    public func getSnapshots() -> [ViewBodySnapshot] {
        lock.lock()
        let currentEntries = entries
        let currentDateProvider = dateProvider
        lock.unlock()

        return currentEntries.values.map { entry in
            let cutoff = currentDateProvider.now().timeIntervalSince1970 - 1.0
            let recentCount = entry.recentTimestamps.filter { $0 >= cutoff }.count
            let avgDuration = entry.durationCount > 0
                ? entry.totalDurationMs / Double(entry.durationCount)
                : nil

            return ViewBodySnapshot(
                id: entry.id,
                viewName: entry.viewName,
                totalCount: entry.totalCount,
                rollingAverage: Double(recentCount),
                averageDurationMs: avgDuration
            )
        }
    }

    private func broadcastSnapshot() {
        guard AutoMobileSDK.shared.isEnabled else { return }
        let snapshots = getSnapshots()
        guard !snapshots.isEmpty else { return }

        let event = SdkViewBodySnapshotEvent(snapshots: snapshots)
        lock.lock()
        let currentBuffer = buffer
        lock.unlock()
        currentBuffer?.add(event)
    }

    // MARK: - Testing Support

    internal func reset() {
        lock.lock()
        snapshotTimer?.cancel()
        snapshotTimer = nil
        entries.removeAll()
        _isEnabled = false
        buffer = nil
        dateProvider = SystemDateProvider()
        lock.unlock()
    }
}

// MARK: - Entry

extension ViewBodyTracker {
    struct Entry {
        let id: String
        let viewName: String?
        var totalCount: Int = 0
        var recentTimestamps: [TimeInterval] = []
        var totalDurationMs: Double = 0
        var durationCount: Int = 0
        /// Timestamp of the most recent body evaluation, used for LRU eviction.
        var lastUpdated: TimeInterval = 0
    }
}

// MARK: - SwiftUI View Modifier

/// A view modifier that tracks view body evaluations.
public struct TrackViewBodyModifier: ViewModifier {
    let id: String
    let viewName: String?

    public func body(content: Content) -> some View {
        ViewBodyTracker.shared.recordBodyEvaluation(id: id, viewName: viewName)
        return content
    }
}

public extension View {
    /// Track body evaluations of this view.
    func trackViewBody(id: String, viewName: String? = nil) -> some View {
        modifier(TrackViewBodyModifier(id: id, viewName: viewName))
    }
}

/// A wrapper view that measures body evaluation duration.
public struct MeasureViewBody<Content: View>: View {
    let id: String
    let viewName: String?
    let content: () -> Content

    public init(
        id: String,
        viewName: String? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.id = id
        self.viewName = viewName
        self.content = content
    }

    public var body: some View {
        let start = CFAbsoluteTimeGetCurrent()
        let result = content()
        let duration = (CFAbsoluteTimeGetCurrent() - start) * 1000
        ViewBodyTracker.shared.recordBodyEvaluation(id: id, viewName: viewName)
        ViewBodyTracker.shared.recordDuration(id: id, durationMs: duration)
        return result
    }
}
