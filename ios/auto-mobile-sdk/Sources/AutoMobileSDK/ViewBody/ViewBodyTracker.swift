import Foundation
import os
import SwiftUI

/// Tracks SwiftUI view body evaluations.
/// iOS equivalent of Android's RecompositionTracker for Compose.
public final class ViewBodyTracker: Sendable {
    public static let shared = ViewBodyTracker()

    private struct State: Sendable {
        var entries: [String: Entry] = [:]
        var isEnabled = false
        var buffer: SdkEventBuffer?
        var snapshotTimer: (any TimerScheduling)?
        var dateProvider: DateProvider = SystemDateProvider()
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    private let snapshotIntervalMs = 1000

    /// Upper bound on tracked entries. Apps may use per-instance ids (e.g.
    /// `trackViewBody(id: item.uuid)` over a long/paginated feed), which would
    /// otherwise grow `entries` without bound for the life of the process
    /// (issue #3624). When the cap is exceeded we evict the least-recently-updated
    /// entries in a batch so the O(n) eviction scan is amortized across inserts.
    private let maxEntries = 512
    private let evictionBatch = 64

    private init() {}

    func initialize(buffer: SdkEventBuffer, dateProvider: DateProvider = SystemDateProvider()) {
        state.withLock { state in
            state.buffer = buffer
            state.dateProvider = dateProvider
        }
    }

    /// Whether tracking is enabled.
    public var isEnabled: Bool {
        state.withLock { $0.isEnabled }
    }

    /// Enable or disable tracking.
    public func setEnabled(_ enabled: Bool) {
        setEnabled(enabled, timerFactory: nil)
    }

    /// Enable or disable tracking with an injectable timer factory (internal for testing).
    func setEnabled(_ enabled: Bool, timerFactory: (@Sendable () -> any TimerScheduling)?) {
        let timerToSchedule = state.withLock { state -> (any TimerScheduling)? in
            state.isEnabled = enabled

            if enabled && state.snapshotTimer == nil {
                let timer = timerFactory?() ?? GCDTimer()
                state.snapshotTimer = timer
                return timer
            } else if !enabled {
                state.snapshotTimer?.cancel()
                state.snapshotTimer = nil
            }
            return nil
        }
        timerToSchedule?.schedule(intervalMs: snapshotIntervalMs) { [weak self] in
            self?.broadcastSnapshot()
        }
    }

    /// Record a view body evaluation.
    public func recordBodyEvaluation(
        id: String,
        viewName: String? = nil
    ) {
        guard isEnabled else { return }

        state.withLock { state in
            let entry = state.entries[id] ?? Entry(id: id, viewName: viewName)
            var updated = entry
            updated.totalCount += 1
            let now = state.dateProvider.now().timeIntervalSince1970
            updated.lastUpdated = now
            updated.recentTimestamps.append(now)
            // Keep only timestamps from the last second for rolling average
            let cutoff = now - 1.0
            updated.recentTimestamps.removeAll { $0 < cutoff }
            state.entries[id] = updated
            enforceEntryCapLocked(&state)
        }
    }

    /// Evict least-recently-updated entries once the cap is exceeded, down to a
    /// low-water mark so this scan runs at most once per `evictionBatch` inserts.
    /// Must be called with `state` locked.
    private func enforceEntryCapLocked(_ state: inout State) {
        guard state.entries.count > maxEntries else { return }
        let target = maxEntries - evictionBatch
        let removeCount = state.entries.count - target
        let oldestKeys = state.entries
            .sorted { $0.value.lastUpdated < $1.value.lastUpdated }
            .prefix(removeCount)
            .map { $0.key }
        for key in oldestKeys {
            state.entries.removeValue(forKey: key)
        }
    }

    /// Record composition duration for a view.
    public func recordDuration(id: String, durationMs: Double) {
        guard isEnabled else { return }

        state.withLock { state in
            guard var entry = state.entries[id] else { return }
            entry.totalDurationMs += durationMs
            entry.durationCount += 1
            state.entries[id] = entry
        }
    }

    /// Get current snapshots.
    public func getSnapshots() -> [ViewBodySnapshot] {
        let (currentEntries, currentDateProvider) = state.withLock { state in
            (state.entries, state.dateProvider)
        }

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
        let currentBuffer = state.withLock { $0.buffer }
        currentBuffer?.add(event)
    }

    // MARK: - Testing Support

    func reset() {
        state.withLock { state in
            state.snapshotTimer?.cancel()
            state.snapshotTimer = nil
            state.entries.removeAll()
            state.isEnabled = false
            state.buffer = nil
            state.dateProvider = SystemDateProvider()
        }
    }
}

// MARK: - Entry

extension ViewBodyTracker {
    struct Entry: Sendable {
        let id: String
        let viewName: String?
        var totalCount = 0
        var recentTimestamps: [TimeInterval] = []
        var totalDurationMs: Double = 0
        var durationCount = 0
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

extension View {
    /// Track body evaluations of this view.
    public func trackViewBody(id: String, viewName: String? = nil) -> some View {
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
