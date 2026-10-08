import Foundation

/// Why an overlay went away; the `reason` in the terminal `dismissed` event's payload.
enum OverlayDismissReason: String {
    /// The host dismiss control or a spec `dismiss` action.
    case user
    /// A `dismiss_overlay` request.
    case agent
}

/// One `overlay_event` push, before the wall-clock timestamp is attached.
struct OverlayEvent: Equatable {
    let id: String
    let sequence: Int
    let kind: String
    let name: String?
    let payload: JSONValue
    let state: [String: JSONValue]
    let pages: [String: Int]

    /// The wire object, in the shape of `OverlayEvent` in `ctrlProxyProtocol.ts`.
    func wireObject(timestamp: Int) -> [String: Any] {
        [
            "type": "overlay_event",
            "timestamp": timestamp,
            "id": id,
            "sequence": sequence,
            "kind": kind,
            "name": name as Any? ?? NSNull(),
            "payload": payload.foundationObject,
            "state": JSONValue.object(state).foundationObject,
            "pages": pages,
        ]
    }
}

extension JSONValue {
    /// The `JSONSerialization`-compatible form.
    var foundationObject: Any {
        switch self {
        case .null: NSNull()
        case let .bool(value): value
        case let .number(value): value
        case let .string(value): value
        case let .array(values): values.map(\.foundationObject)
        case let .object(values): values.mapValues(\.foundationObject)
        }
    }
}

/// Device-free overlay transitions, mirroring Android's `OverlayRuntime` and the sequence ledger in
/// `OverlayController`. Each mutation returns the events it produced, already sequenced.
struct OverlaySession {
    private(set) var spec: OverlaySpec?
    private(set) var state: [String: JSONValue] = [:]
    private(set) var pages: [String: Int] = [:]
    private(set) var pageCounts: [String: Int] = [:]
    /// Agent-lifetime ledger, per overlay id and monotonic from 1: re-showing an id after a
    /// dismissal or another overlay never rewinds it, because hosts discard lower-or-equal
    /// sequences as duplicates.
    private var sequences: [String: Int] = [:]

    var isShown: Bool {
        spec != nil
    }

    /// A show of the overlay already on screen replaces it in place: its spec state is
    /// authoritative and each pager that survives keeps its page, matched by id and clamped to the
    /// new page count. Any other show, or one with `reset`, starts fresh: the spec's own state and
    /// every pager on its first page. Event sequences are per id and never rewound either way.
    mutating func show(_ spec: OverlaySpec, reset: Bool = false) {
        let previous = !reset && self.spec?.id == spec.id ? pages : [:]
        pageCounts = spec.root.pagerCounts()
        pages = pageCounts.reduce(into: [:]) { result, entry in
            result[entry.key] = min(max(previous[entry.key] ?? 0, 0), max(entry.value - 1, 0))
        }
        state = spec.state ?? [:]
        self.spec = spec
    }

    func holds(_ condition: Condition) -> Bool {
        condition.holds(state)
    }

    // MARK: Interactions

    /// A tap's actions in order; a `dismiss` ends the overlay and drops the remaining actions.
    mutating func run(_ actions: [OverlayAction]) -> [OverlayEvent] {
        var events: [OverlayEvent] = []
        for action in actions {
            guard isShown else { break }
            switch action.type {
            case "emit":
                events += emit(kind: "emit", name: action.name, payload: action.payload ?? .null)
            case "setPage":
                guard let pager = action.pager, let current = pages[pager] else { continue }
                let target = switch action.page {
                case .string("next"): current + 1
                case .string("prev"): current - 1
                default: action.page?.intValue ?? current
                }
                events += setPage(pager, target)
            case "dismiss":
                events += dismiss(reason: .user)
            default:
                applyStateAction(action)
            }
        }
        return events
    }

    /// `setState`, `toggle` and `increment` are silent. A toggle of a non-boolean, or an increment
    /// of a non-number or to a non-finite value, is a no-op, as on Android.
    private mutating func applyStateAction(_ action: OverlayAction) {
        guard let key = action.key else { return }
        switch action.type {
        case "setState":
            if let value = action.value { state[key] = value }
        case "toggle":
            if case let .bool(stored)? = state[key] { state[key] = .bool(!stored) }
        case "increment":
            if let next = state[key]?.numberValue.map({ $0 + (action.by ?? 1) }), next.isFinite {
                state[key] = .number(next)
            }
        default:
            return
        }
    }

    /// Settled pager position; clamped, and silent when the page does not change.
    mutating func setPage(_ pager: String, _ target: Int) -> [OverlayEvent] {
        guard isShown, let pageCount = pageCounts[pager], pageCount >= 1 else { return [] }
        let clamped = min(max(target, 0), pageCount - 1)
        guard pages[pager] != clamped else { return [] }
        pages[pager] = clamped
        return emit(kind: "page_changed", name: pager, payload: .number(Double(clamped)))
    }

    /// A user edit of a bound control: one `emit` named `change` per changed value, matching
    /// Android's `OverlayRuntime.change`. `setState` actions and wire patches stay silent.
    mutating func change(key: String, value: JSONValue) -> [OverlayEvent] {
        guard isShown, state[key] != value else { return [] }
        state[key] = value
        return emit(kind: "emit", name: "change", payload: .object(["key": .string(key), "value": value]))
    }

    /// A `switch` or `checkbox` tap flips its bound boolean, then runs the node's own actions. A key
    /// that no longer holds a boolean leaves the control inert.
    mutating func toggle(key: String, then actions: [OverlayAction]) -> [OverlayEvent] {
        guard isShown, case let .bool(stored)? = state[key] else { return [] }
        return change(key: key, value: .bool(!stored)) + run(actions)
    }

    /// A `tabBar`/`bottomNav` selection drives its pager when it has one, else its state key.
    mutating func select(index: Int, pager: String?, key: String?) -> [OverlayEvent] {
        if let pager { return setPage(pager, index) }
        if let key { return change(key: key, value: .number(Double(index))) }
        return []
    }

    /// The terminal event: every dismissal emits exactly one `dismissed`, carrying its reason.
    mutating func dismiss(reason: OverlayDismissReason) -> [OverlayEvent] {
        guard isShown else { return [] }
        let events = emit(kind: "dismissed", name: nil, payload: .object(["reason": .string(reason.rawValue)]))
        spec = nil
        return events
    }

    private mutating func emit(kind: String, name: String?, payload: JSONValue) -> [OverlayEvent] {
        guard let id = spec?.id else { return [] }
        let sequence = (sequences[id] ?? 0) + 1
        sequences[id] = sequence
        return [OverlayEvent(
            id: id,
            sequence: sequence,
            kind: kind,
            name: name,
            payload: payload,
            state: state,
            pages: pages
        )]
    }

    // MARK: Status

    func missingAssets(available: Set<String>) -> [String] {
        guard let spec else { return [] }
        var ids = Set<String>()
        spec.root.collectAssets(into: &ids)
        return ids.subtracting(available).sorted()
    }
}

extension OverlayNode {
    /// Pager ids and their page counts, so `setPage` can clamp without consulting the view tree.
    func pagerCounts() -> [String: Int] {
        var counts: [String: Int] = [:]
        collectPagers(into: &counts)
        return counts
    }
}
