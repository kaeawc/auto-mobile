import Foundation
#if canImport(UIKit)
    import UIKit
#endif

/// A node's `transition` as authored: its type alone, or `{type, delayMs?}` (#15247). The agent
/// keeps the type; delays, `stagger` and `blurReplace` need `prototype_choreography_v1`, which iOS
/// does not advertise yet, so the host refuses them before they arrive.
struct PrototypeTransitionForm: Decodable {
    let type: String

    private enum CodingKeys: String, CodingKey { case type }

    init(from decoder: Decoder) throws {
        if let name = try? decoder.singleValueContainer().decode(String.self) {
            type = name
        } else {
            type = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .type)
        }
    }
}

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

enum PrototypeMotionProfile: Equatable {
    case full, reduced, off
}

/// The system accessibility settings that select the reduced profile (#15244). Injected so tests
/// drive them without UIKit.
protocol PrototypeAccessibilityProviding {
    var isReduceMotionEnabled: Bool { get }
    var prefersCrossFadeTransitions: Bool { get }
}

/// The live settings: `UIAccessibility.isReduceMotionEnabled` and `prefersCrossFadeTransitions`.
struct PrototypeSystemAccessibility: PrototypeAccessibilityProviding {
    var isReduceMotionEnabled: Bool {
        #if canImport(UIKit)
            return UIAccessibility.isReduceMotionEnabled
        #else
            return false
        #endif
    }

    var prefersCrossFadeTransitions: Bool {
        #if canImport(UIKit)
            return UIAccessibility.prefersCrossFadeTransitions
        #else
            return false
        #endif
    }
}

/// The spec can disable all animation; system Reduce Motion and the cross-fade preference select
/// the reduced profile, which preserves crossfades and colors. Neither selects `off`.
struct PrototypeMotion: Equatable {
    let profile: PrototypeMotionProfile
    var enabled: Bool { profile != .off }
    var spatial: Bool { profile == .full }
    var fadeOnly: Bool { profile == .reduced }
    var fadeDuration: Double? { enabled ? 0.25 : nil }

    init(
        specMotion: String?, reduceMotion: Bool,
        accessibility: PrototypeAccessibilityProviding = PrototypeSystemAccessibility()
    ) {
        let systemReduces = reduceMotion || accessibility.isReduceMotionEnabled
            || accessibility.prefersCrossFadeTransitions
        profile = specMotion == "none" ? .off : (specMotion == "reduced" || systemReduces ? .reduced : .full)
    }

    /// Nodes without `visibleWhen` have nothing to animate, so callers pass the transition only for
    /// those that do. A stack's transition controls navigation only, so visibility uses the default.
    /// A `shared` node (one with a `sharedKey`) crossfades even under `transition: "none"`, as on Android.
    func visibility(
        transition: String?,
        nodeType: String? = nil,
        shared: Bool = false
    )
        -> PrototypeVisibilityTransition
    {
        guard enabled else { return .instant }
        let transition = nodeType == "stack" ? nil : transition
        if transition == "none" { return shared ? .fade : .instant }
        if fadeOnly { return .fade }
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
        spatial ? 0.25 : nil
    }
}

extension PrototypeMotion {
    /// Seconds the press-scale feedback (`pressScale`) springs for; nil snaps instantly under spec
    /// `motion: "none"` or the reduced profile (#10885).
    var pressScaleDuration: Double? {
        spatial ? 0.2 : nil
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
    func drawnChildren(
        holds: (Condition) -> Bool, stacks: [String: PrototypeStackSnapshot] = [:]
    )
        -> [(offset: Int, node: PrototypeNode)]
    {
        let nodes = type == "stack" ? currentChildEntries(path: "root", pages: [:], stacks: stacks)
            .map(\.node) : children ?? []
        return Array(nodes.enumerated()).filter { $0.element.drawsInPlace(holds: holds) }
            .map { (offset: $0.offset, node: $0.element) }
    }

    /// What decides a container's size from its direct children: whether each one is shown and the
    /// width and height its style resolves to under the current state. The renderer animates size
    /// changes only when this changes, so text edits and other content updates stay unanimated.
    func containerLayoutSignature(
        state: [String: JSONValue], stacks: [String: PrototypeStackSnapshot] = [:], holds: (Condition) -> Bool
    )
        -> [String]
    {
        let nodes = type == "stack" ? currentChildEntries(path: "root", pages: [:], stacks: stacks, state: state)
            .map(\.node) : children ?? []
        return nodes.map { child in
            let shown = child.visibleWhen.map(holds) ?? true
            let style = child.resolvedStyle(state: state)
            let bounds = [
                style?.weight,
                style?.minWidth,
                style?.maxWidth,
                style?.minHeight,
                style?.maxHeight,
                style?.aspectRatio,
            ]
            .map { $0.map { "\($0)" } ?? "-" }.joined(separator: ",")
            return "\(shown)|\(Self.describe(style?.width))|\(Self.describe(style?.height))|\(bounds)"
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
    var nowMilliseconds: Int { get }
    func schedule(afterMilliseconds: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle
}

extension PrototypeClock {
    var nowMilliseconds: Int { Int(Date().timeIntervalSince1970 * 1000) }
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
