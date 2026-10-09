import Foundation

/// How a `visibleWhen` node enters and leaves, after the spec's `motion`, the node's `transition`
/// and the system's reduce-motion setting are applied.
enum OverlayVisibilityTransition: Equatable {
    case instant
    /// The default when `transition` is absent: fade plus expand.
    case standard
    case fade
    case expand
    case slide
}

/// Android's overlay motion decision (#10442), device-free. Motion is on unless the spec sets
/// `motion: "none"` or the system reduces motion (`UIAccessibility.isReduceMotionEnabled`).
struct OverlayMotion: Equatable {
    let enabled: Bool

    init(specMotion: String?, reduceMotion: Bool) {
        enabled = specMotion != "none" && !reduceMotion
    }

    /// Nodes without `visibleWhen` have nothing to animate, so callers pass the transition only for
    /// those that do.
    func visibility(transition: String?) -> OverlayVisibilityTransition {
        guard enabled else { return .instant }
        switch transition {
        case "none": return .instant
        case "fade": return .fade
        case "expand": return .expand
        case "slide": return .slide
        default: return .standard
        }
    }
}

/// A scheduled callback that can be cancelled before it fires.
protocol OverlayTimerHandle: AnyObject {
    func cancel()
}

/// Wall-clock timers behind an interface so snackbar timeouts run without real time in tests.
protocol OverlayClock {
    func schedule(afterMilliseconds: Int, _ fire: @escaping () -> Void) -> OverlayTimerHandle
}

/// Fires on the main queue, where the overlay model lives. A plain timer: neither the reduce-motion
/// setting nor animation scales stretch or skip it, as on Android.
struct SystemOverlayClock: OverlayClock {
    func schedule(afterMilliseconds: Int, _ fire: @escaping () -> Void) -> OverlayTimerHandle {
        let box = MainQueueCallback(fire)
        let item = DispatchWorkItem { box.run() }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(afterMilliseconds), execute: item)
        return WorkItemTimer(item)
    }
}

private final class MainQueueCallback: @unchecked Sendable {
    private let callback: () -> Void
    init(_ callback: @escaping () -> Void) { self.callback = callback }
    func run() { callback() }
}

private final class WorkItemTimer: OverlayTimerHandle, @unchecked Sendable {
    private let item: DispatchWorkItem
    init(_ item: DispatchWorkItem) { self.item = item }
    func cancel() { item.cancel() }
}

/// Closes a `snackbar` that sets `durationMs` that long after it opens. `sync` is called with the
/// snackbars currently open; one timer runs per open snackbar, keyed by its position, `openWhen`
/// key and duration (Android's `LaunchedEffect(openWhen, durationMs)`), so a re-show of the same
/// spec keeps the running timer while a closed or changed snackbar cancels or restarts it.
final class SnackbarTimeouts {
    private struct Key: Hashable {
        let ordinal: Int
        let openKey: String
        let durationMs: Int
    }

    private let clock: OverlayClock
    private let close: (OverlayNode) -> Void
    private var timers: [Key: OverlayTimerHandle] = [:]

    init(clock: OverlayClock, close: @escaping (OverlayNode) -> Void) {
        self.clock = clock
        self.close = close
    }

    var pendingCount: Int {
        timers.count
    }

    func sync(openModals: [OverlayNode]) {
        var wanted: [Key: OverlayNode] = [:]
        for (ordinal, node) in openModals.filter({ $0.type == "snackbar" }).enumerated() {
            guard let duration = node.durationMs, duration > 0, let openKey = node.openCondition?.key else {
                continue
            }
            wanted[Key(ordinal: ordinal, openKey: openKey, durationMs: duration)] = node
        }
        for key in timers.keys where wanted[key] == nil {
            timers.removeValue(forKey: key)?.cancel()
        }
        for (key, node) in wanted where timers[key] == nil {
            timers[key] = clock.schedule(afterMilliseconds: key.durationMs) { [weak self] in
                self?.fire(key, node)
            }
        }
    }

    private func fire(_ key: Key, _ node: OverlayNode) {
        timers[key] = nil
        close(node)
    }
}
