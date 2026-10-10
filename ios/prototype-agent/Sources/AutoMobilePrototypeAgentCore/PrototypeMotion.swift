import Foundation

/// How a `visibleWhen` node enters and leaves, after the spec's `motion`, the node's `transition`
/// and the system's reduce-motion setting are applied.
enum PrototypeVisibilityTransition: Equatable {
    case instant
    /// The default when `transition` is absent: fade plus expand.
    case standard
    case fade
    case expand
    case slide
}

/// Android's prototype motion decision (#10442), device-free. Motion is on unless the spec sets
/// `motion: "none"` or the system reduces motion (`UIAccessibility.isReduceMotionEnabled`).
struct PrototypeMotion: Equatable {
    let enabled: Bool

    init(specMotion: String?, reduceMotion: Bool) {
        enabled = specMotion != "none" && !reduceMotion
    }

    /// Nodes without `visibleWhen` have nothing to animate, so callers pass the transition only for
    /// those that do.
    func visibility(transition: String?) -> PrototypeVisibilityTransition {
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

extension PrototypeMotion {
    /// Seconds a container takes to settle after its children appear, disappear or resize
    /// (Android's `animateContentSize`); nil is instant, so settled screenshots never see an
    /// in-flight size when motion is off.
    var containerSizeDuration: Double? {
        enabled ? 0.25 : nil
    }
}

extension PrototypeMotion {
    /// Seconds the press-scale feedback (`pressScale`) springs for; nil snaps instantly under spec
    /// `motion: "none"` or Reduce Motion, as every other animation does (#10885).
    var pressScaleDuration: Double? {
        enabled ? 0.2 : nil
    }
}

extension PrototypeNode {
    /// Whether the node takes a slot in its parent's stack: not hidden by `visibleWhen`, not drawn
    /// elsewhere (an anchored node is drawn by the anchor layer, a dialog or snackbar by the modal
    /// layer) and not a closed `bottomSheet`. A stack puts its spacing around every child it is
    /// given, even an empty one, so a parent leaves these out (#10912).
    func drawsInPlace(holds: (Condition) -> Bool) -> Bool {
        if let visibleWhen, !holds(visibleWhen) { return false }
        if anchor != nil || prototypeModalTypes.contains(type) { return false }
        if type == "bottomSheet", !(openWhen.map(holds) ?? false) { return false }
        return true
    }

    /// The `children` a container lays out, each with its position among all of them (a stable
    /// identity across show and hide); those that do not draw in place are left out.
    func drawnChildren(holds: (Condition) -> Bool) -> [(offset: Int, node: PrototypeNode)] {
        Array((children ?? []).enumerated()).filter { $0.element.drawsInPlace(holds: holds) }
            .map { (offset: $0.offset, node: $0.element) }
    }

    /// What decides a container's size from its direct children: whether each one is shown and the
    /// width and height its style resolves to under the current state. The renderer animates size
    /// changes only when this changes, so text edits and other content updates stay unanimated.
    func containerLayoutSignature(state: [String: JSONValue], holds: (Condition) -> Bool) -> [String] {
        (children ?? []).map { child in
            let shown = child.visibleWhen.map(holds) ?? true
            let style = child.resolvedStyle(state: state)
            return "\(shown)|\(Self.describe(style?.width))|\(Self.describe(style?.height))"
        }
    }

    private static func describe(_ dimension: Dimension?) -> String {
        switch dimension {
        case nil: return "-"
        case .fill: return "fill"
        case .wrap: return "wrap"
        case let .points(value): return "\(value)"
        }
    }
}

/// A scheduled callback that can be cancelled before it fires.
protocol PrototypeTimerHandle: AnyObject {
    func cancel()
}

/// Wall-clock timers behind an interface so snackbar timeouts run without real time in tests.
protocol PrototypeClock {
    func schedule(afterMilliseconds: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle
}

/// Fires on the main queue, where the prototype model lives. A plain timer: neither the reduce-motion
/// setting nor animation scales stretch or skip it, as on Android.
struct SystemPrototypeClock: PrototypeClock {
    func schedule(afterMilliseconds: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle {
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

private final class WorkItemTimer: PrototypeTimerHandle, @unchecked Sendable {
    private let item: DispatchWorkItem
    init(_ item: DispatchWorkItem) { self.item = item }
    func cancel() { item.cancel() }
}

/// Closes a `snackbar` that sets `durationMs` that long after it opens. `sync` is called with the
/// snackbars currently open; one timer runs per open snackbar, keyed by its `openWhen` key and
/// duration (Android's `LaunchedEffect(openWhen, durationMs)`), so another snackbar opening or
/// closing earlier in the tree never restarts it, while a closed or changed snackbar cancels or
/// restarts. `duplicate` only separates snackbars that share both, so each keeps its own timer.
final class SnackbarTimeouts {
    private struct Key: Hashable {
        let duplicate: Int
        let openKey: String
        let durationMs: Int
    }

    private let clock: PrototypeClock
    private let close: (PrototypeNode) -> Void
    private var timers: [Key: PrototypeTimerHandle] = [:]

    init(clock: PrototypeClock, close: @escaping (PrototypeNode) -> Void) {
        self.clock = clock
        self.close = close
    }

    var pendingCount: Int {
        timers.count
    }

    func sync(openModals: [PrototypeNode]) {
        var wanted: [Key: PrototypeNode] = [:]
        var order: [Key] = []
        var seen: [Key: Int] = [:]
        for node in openModals where node.type == "snackbar" {
            guard let duration = node.durationMs, duration > 0, let openKey = node.openCondition?.key else {
                continue
            }
            let base = Key(duplicate: 0, openKey: openKey, durationMs: duration)
            let copy = seen[base, default: 0]
            seen[base] = copy + 1
            let key = Key(duplicate: copy, openKey: openKey, durationMs: duration)
            wanted[key] = node
            order.append(key)
        }
        for key in timers.keys where wanted[key] == nil {
            timers.removeValue(forKey: key)?.cancel()
        }
        for key in order where timers[key] == nil {
            guard let node = wanted[key] else { continue }
            timers[key] = clock.schedule(afterMilliseconds: key.durationMs) { [weak self] in
                self?.fire(key, node)
            }
        }
    }

    private func fire(_ key: Key, _ node: PrototypeNode) {
        timers[key] = nil
        close(node)
    }
}
