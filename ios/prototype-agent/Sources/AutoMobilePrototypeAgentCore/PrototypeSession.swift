import Foundation
import os

private let requestCompletionLog = Logger(
    subsystem: "dev.jasonpearson.automobile.prototype-agent",
    category: "prototype"
)

/// Why an embedded prototype went away.
/// This enum may gain cases; include a default branch when switching over it.
public enum PrototypeDismissReason: String, Sendable {
    /// The host dismiss control or a spec `dismiss` action.
    case user
}

/// Internal lifecycle reasons retain the injected agent's wire protocol.
enum PrototypeSessionDismissReason: String, Sendable {
    /// The host dismiss control or a spec `dismiss` action.
    case user
    /// A `dismiss_prototype` request.
    case agent
    /// The last authenticated host connection closed (or a prototype was shown after that edge), so
    /// a crashed daemon leaves no orphan. Same string as Android.
    case disconnect
    /// The idle TTL elapsed (`PrototypeIdleTimer`). Same string as Android.
    case ttl
}

/// A prototype event with a semantic category and JSON snapshots for app-owned Codable payloads.
/// The session creates it before the model attaches the wire timestamp.
public struct PrototypeEvent: Equatable, Sendable {
    /// The prototype that emitted this event.
    public let id: String
    /// Monotonic event sequence for this prototype.
    public let sequence: Int
    let wireKind: String
    /// The authored event name, state key, or data path.
    public let name: String?
    let payload: JSONValue
    let state: [String: JSONValue]
    let pages: [String: Int]
    let stacks: [String: PrototypeStackSnapshot]
    var resolvedContext: PrototypeResolvedEmitContext?
    var keys: [String]?
    var validity: [String: Bool]?
    var embeddedWire: Data? = nil
    var wireTimestamp = 0
    var isStateChange = false

    var context: [String: JSONValue]? { resolvedContext?.context }
    var contextTruncated: Bool? { resolvedContext?.contextTruncated }

    /// The wire object, in the shape of `PrototypeEvent` in `ctrlProxyProtocol.ts`.
    func wireObject(timestamp: Int) -> [String: Any] {
        var object: [String: Any] = [
            "type": "prototype_event",
            "timestamp": timestamp,
            "id": id,
            "sequence": sequence,
            "kind": wireKind,
            "name": name as Any? ?? NSNull(),
            "payload": payload.foundationObject,
            "state": JSONValue.object(state).foundationObject,
            "pages": pages,
            "stacks": stacks.mapValues(\.wireObject),
        ]
        if let context { object["context"] = JSONValue.object(context).foundationObject }
        if contextTruncated == true { object["contextTruncated"] = true }
        if let keys { object["keys"] = keys }
        if let validity { object["validity"] = validity }
        return object
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

/// Device-free prototype transitions, mirroring Android's `PrototypeRuntime` and the sequence ledger in
/// `PrototypeController`. Each mutation returns the events it produced, already sequenced.
struct PrototypeSession {
    private(set) var spec: PrototypeSpec?
    private(set) var state: [String: JSONValue] = [:] {
        didSet { if tracksStateRevisions { noteStateWrites(since: oldValue) } }
    }

    /// Off while a show or patch assigns `state` itself: neither is a device write (#11675).
    private var tracksStateRevisions = true
    /// The revision of the last device write (or accepted patch) to each state key since the show; a
    /// patch built on an older `baseRevision` conflicts on those keys.
    private var stateRevisions: [String: Int] = [:]
    /// Bumped when the drawn tree is rebuilt (a data write or a patch), so the model replaces its spec.
    private(set) var structureRevision = 0
    private(set) var pages: [String: Int] = [:]
    private(set) var stacks: [String: PrototypeStackSnapshot] = [:]
    private(set) var stackChanges: [String: PrototypeStackChange] = [:]
    private(set) var stackEntries: [String: [PrototypeStackEntry]] = [:]
    private var stackRevision = 0
    private var nextStackEntry = 0
    private var stackNodes: [String: PrototypeNode] = [:]
    private(set) var pageCounts: [String: Int] = [:]
    /// Keys whose errors have been revealed by change, blur or a failed guard.
    private(set) var shownErrors: Set<String> = []
    /// Agent-lifetime ledger, per prototype id and monotonic from 1: re-showing an id after a
    /// dismissal or another prototype never rewinds it, because hosts discard lower-or-equal
    /// sequences as duplicates.
    private var sequences: [String: Int] = [:]
    /// Device data writes per prototype id (#12519), monotonic like `sequences` and for the same
    /// reason: a host's `baseRevision` from before a re-show must not look newer than a write after it.
    private var revisions: [String: Int] = [:]
    /// `request` actions in flight (#12529) and the commands for the driver that runs them; see
    /// `takeRequestCommands`.
    private(set) var requests = PrototypeRequestLedger()
    private var platformEventData: JSONValue?
    private var timerCommands: [PrototypeTimerCommand] = []

    mutating func takeTimerCommands() -> [PrototypeTimerCommand] {
        defer { timerCommands = [] }
        return timerCommands
    }

    /// The shown prototype's `appearance` from its show request.
    /// The shown spec's size outside its `state`, for the spec byte cap (#11562); see
    /// `PrototypeStateValidator.stateBytes`.
    private var nonStateBytes = 0
    /// End-edge trackers survive tree rebuilds and are reset by every show.
    private var listEnds: [String: PrototypeListEndDriver] = [:]
    private(set) var appearanceOverride = PrototypeAppearanceOverride.device
    /// The device's own appearance, as last reported through `setDeviceDark`; it outlives a show.
    private(set) var deviceDark = false
    /// The mode the host was last told for the shown prototype, by its show result or by an
    /// `appearance_changed` event; nil while nothing is shown.
    private var reportedDark: Bool?

    /// The shown spec owns data; device actions can only change state.
    var data: [String: JSONValue]? { spec?.data }

    var isShown: Bool {
        spec != nil
    }

    /// The shown prototype's device revision: 1 after its first show (each later show and each device
    /// data or state write or accepted patch adds one; Android counts the same way, #13040).
    /// The same counter is reported as `revision` in a data write's `change` event and in a patch
    /// result (#11675).
    var dataRevision: Int {
        spec.flatMap { revisions[$0.id] } ?? 0
    }

    /// The last event sequence issued for the shown prototype's id (0 before its first event), which
    /// `get_prototype_status` reports so a host inspecting the agent can resume past it.
    var lastSequence: Int {
        spec.flatMap { sequences[$0.id] } ?? 0
    }

    /// A show of the prototype already on screen replaces it in place: its spec state is
    /// authoritative and each pager that survives keeps its page, matched by id and clamped to the
    /// new page count. Stack paths drop unknown screens and fall back to start when empty.
    /// Any other show, or one with `reset`, starts fresh: the spec's own state (or `restoredState`, the
    /// spec's with its stored values over it), every pager on its first page and every stack at start.
    /// Event sequences are per id and never rewound either way.
    /// `appearance` is the request's own: a show that carries none follows the device again.
    mutating func show(
        _ spec: PrototypeSpec,
        reset: Bool = false,
        appearance: PrototypeAppearanceOverride = .device,
        specBytes: Int? = nil,
        restoredState: [String: JSONValue]? = nil
    ) {
        listEnds = [:]
        timerCommands.append(.cancelAll)
        appearanceOverride = appearance
        // The agent keeps no raw spec, so the request's own size (when the caller has it) less the
        // state it carried is what the cap adds every later state to; without it only state counts.
        nonStateBytes = max(0, (specBytes ?? 0) - PrototypeStateValidator.stateBytes(spec.state ?? [:]))
        let keepNavigation = !reset && self.spec?.id == spec.id
        // A same-id replace keeps its requests running; any other show ends the old prototype's.
        if !keepNavigation { requests.cancelAll() }
        rebuildNavigation(
            for: spec.root,
            keepingPages: keepNavigation ? pages : [:],
            keepingStacks: keepNavigation ? stacks : [:]
        )
        shownErrors = []
        // Stored values (#12526) arrive already applied by `PrototypeStorageCoordinator.prepare`, before
        // the first draw; restoring is not a change, so no event is emitted and no revision moves.
        tracksStateRevisions = false
        state = restoredState ?? spec.state ?? [:]
        tracksStateRevisions = true
        // Every show is one device revision, as on Android's `PrototypeController.nextRevision` (#13040,
        // #11675): the first show reports 1, a re-show moves it on and none rewinds it. The spec's own
        // state keys start at that revision, like Android's `initialRevision`.
        let shownRevision = (revisions[spec.id] ?? 0) + 1
        revisions[spec.id] = shownRevision
        stateRevisions = state.keys.reduce(into: [:]) { $0[$1] = shownRevision }
        self.spec = spec
        // The show result reports this mode, so the show itself is not a change.
        reportedDark = self.appearance?.dark
    }

    /// Stack and pager bookkeeping for `root`: surviving stack paths drop unknown screens and fall
    /// back to start when empty; each surviving pager keeps its page, clamped to its page count.
    private mutating func rebuildNavigation(
        for root: PrototypeNode,
        keepingPages previous: [String: Int],
        keepingStacks previousStacks: [String: PrototypeStackSnapshot]
    ) {
        let previousNodes = stackNodes
        let previousEntries = stackEntries
        let previousChanges = stackChanges
        stackNodes = [:]
        root.collectStacks(into: &stackNodes)
        stacks = stackNodes.mapValues { node in
            let path = (node.id.flatMap { previousStacks[$0]?.path } ?? [])
                .filter { node.screens?[$0] != nil }.prefix(PrototypeLimits.maxStackDepth)
            return PrototypeStackSnapshot(path: path.isEmpty ? [node.start ?? ""] : Array(path))
        }
        stackChanges = [:]
        stackEntries = [:]
        for (id, snapshot) in stacks {
            let before = previousStacks[id]?.path ?? []
            let retained = zip(before, snapshot.path).prefix(while: { $0.0 == $0.1 }).count
            var entries = Array((previousEntries[id] ?? []).prefix(retained))
            for screen in snapshot.path.dropFirst(entries.count) {
                nextStackEntry += 1
                entries.append(PrototypeStackEntry(id: nextStackEntry, screen: screen))
            }
            stackEntries[id] = entries
            if before == snapshot.path,
               previousNodes[id]?.screenDefinitions == stackNodes[id]?.screenDefinitions,
               let change = previousChanges[id]
            {
                stackChanges[id] = change
            } else {
                stackRevision += 1
                stackChanges[id] = PrototypeStackChange(direction: .reset, transition: .none, revision: stackRevision)
            }
        }
        pageCounts = root.pagerCounts()
        pages = pageCounts.reduce(into: [:]) { result, entry in
            result[entry.key] = min(max(previous[entry.key] ?? 0, 0), max(entry.value - 1, 0))
        }
    }

    func holds(_ condition: Condition) -> Bool {
        condition.holds(state)
    }

    // MARK: Appearance

    /// The mode the shown prototype draws in and why; nil while nothing is shown. It is derived
    /// from the spec, the current state and pages, the show's override and the device, so the
    /// palette, the host chrome, the UIKit trait and the reports all read this one value.
    var appearance: PrototypeAppearance? {
        guard let spec else { return nil }
        return .resolve(
            theme: spec.theme,
            root: spec.root,
            state: state,
            pages: pages,
            stacks: stacks,
            override: appearanceOverride,
            deviceDark: deviceDark
        )
    }

    /// The device's appearance changed (or was read for the first time). The shown prototype is
    /// re-resolved, keeping its state and pages; see `appearanceChange` for the event.
    mutating func setDeviceDark(_ dark: Bool) -> [PrototypeEvent] {
        deviceDark = dark
        return appearanceChange()
    }

    /// Runs one transition and appends the `appearance_changed` it caused, if any: a state or page
    /// change can move the leading authored background (a `styleWhen`, a `visibleWhen`, a pager
    /// page) and with it the inferred mode. The event follows the `change` or `page_changed` that
    /// caused it. Every transition of a shown prototype goes through here.
    mutating func transition(_ body: (inout PrototypeSession) -> [PrototypeEvent]) -> [PrototypeEvent] {
        let events = body(&self)
        return events + appearanceChange()
    }

    /// Exactly one `appearance_changed` when the shown prototype's mode differs from the one last
    /// reported, whatever changed it, and none otherwise: a repeated report, an explicit or pinned
    /// mode, a change that leaves the mode as it was, nothing shown.
    private mutating func appearanceChange() -> [PrototypeEvent] {
        guard let appearance else {
            reportedDark = nil
            return []
        }
        guard appearance.dark != reportedDark else { return [] }
        reportedDark = appearance.dark
        return emit(kind: "appearance_changed", name: nil, payload: appearance.eventPayload)
    }

    // MARK: Interactions

    mutating func setPlatformState(_ snapshot: [String: JSONValue]) throws {
        guard let spec, spec.platformState != snapshot else { return }
        let limit = PrototypeContractValidator.limit("MAX_PROTOTYPE_PLATFORM_STATE_BYTES")
        guard try JSONEncoder().encode(snapshot).count <= limit else {
            throw PrototypeLimits.violation("platform", "Platform state exceeds limit")
        }
        let rebuilt = try spec.replacingPlatform(snapshot)
        self.spec = rebuilt
        structureRevision += 1
        rebuildNavigation(for: rebuilt.root, keepingPages: pages, keepingStacks: stacks)
    }

    mutating func deliverPlatformEvent(_ name: String, data: JSONValue) throws -> [PrototypeEvent] {
        guard let spec else { return [] }
        let payload = JSONValue.object(["event": .string(name), "data": data])
        guard try JSONEncoder().encode(payload).count <= PrototypeLimits.maxEmitPayloadBytes else {
            throw PrototypeLimits.violation("platform", "Platform event payload exceeds limit")
        }
        let actions = spec.platformHandlers[name] ?? .array([])
        let decoded = try JSONDecoder().decode([PrototypeAction].self, from: JSONEncoder().encode(actions))
        let delivered = emit(kind: "emit", name: "prototype_platform_event", payload: payload)
        platformEventData = data
        defer { platformEventData = nil }
        return delivered + run(decoded)
    }

    /// A tap's actions in order; a `dismiss` ends the prototype and drops the remaining actions.
    /// Android's `PrototypeRuntime.tap` (#10622): if any `setState`/`toggle`/`increment`/`decrement`
    /// changed state, exactly one `change` event carrying the final state follows the last action;
    /// `emit` actions fire in order with the state as it was at that point. A list that nets no
    /// change emits nothing.
    ///
    /// The tap is atomic, as on Android (#11408, #11551): every state write is planned and
    /// validated against the controls bound to its key (`PrototypeStateValidator`) before anything
    /// runs, so one rejected write drops the whole tap with no write, page move or event.
    mutating func run(_ actions: [PrototypeAction]) -> [PrototypeEvent] {
        guard isShown else { return [] }
        if let failed = requireValid(actions) { return failed }
        guard let writes = plannedWrites(actions, from: state) else { return [] }
        return execute(actions, writes)
    }

    /// One interaction as one unit, as Android's `PrototypeRuntime.control`: the control's `own`
    /// writes (a flipped switch, a chosen option, a closed dialog; empty for a plain tap) and every
    /// state write of its `actions` are validated before anything is applied, so a rejected
    /// interaction changes and emits nothing. An accepted one reports the control's own `change`
    /// first, when a value moved, then the action list.
    mutating func control(own: [(String, JSONValue)], then actions: [PrototypeAction]) -> [PrototypeEvent] {
        guard isShown else { return [] }
        if let failed = requireValid(actions) { return failed }
        let (written, moved) = applying(own)
        if !moved.isEmpty, !accepts(written) { return [] }
        guard let writes = plannedWrites(actions, from: written) else { return [] }
        let events: [PrototypeEvent]
        if moved.isEmpty {
            events = []
        } else {
            state = written
            events = emitStateChange(moved)
        }
        return events + execute(actions, writes)
    }

    /// `own` written over the current state (a later write to a key wins) and the keys, in order, whose
    /// final value differs from the current one.
    private func applying(_ own: [(String, JSONValue)]) -> (state: [String: JSONValue], moved: [String]) {
        var written = state
        own.forEach { written[$0.0] = $0.1 }
        var seen = Set<String>()
        let moved = own.map(\.0).filter { state[$0] != written[$0] && seen.insert($0).inserted }
        return (written, moved)
    }

    private typealias PlannedWrite = (key: String, value: JSONValue)

    /// The write each state action of `actions` makes when the list starts from `start`, by action
    /// index; nil when the state it leaves behind is invalid. Nothing is applied here. Actions after
    /// a `dismiss` never run, so they are not planned; a toggle or step that is a no-op has no entry.
    private func plannedWrites(
        _ actions: [PrototypeAction],
        from start: [String: JSONValue]
    )
        -> [Int: PlannedWrite]?
    {
        var planned = start
        var writes: [Int: PlannedWrite] = [:]
        for (index, action) in actions.enumerated() {
            if action.type == "dismiss" { break }
            guard let write = stateWrite(action, in: planned) else { continue }
            planned[write.key] = write.value
            guard accepts(planned) else { return nil }
            writes[index] = write
        }
        return writes
    }

    /// Whether every control, list item, modal and state action of the shown spec accepts `state`.
    private func accepts(_ state: [String: JSONValue]) -> Bool {
        guard let spec else { return false }
        return PrototypeStateValidator.rejection(root: spec.root, state: state, nonStateBytes: nonStateBytes) == nil
    }

    private mutating func applyPlannedWrite(_ write: PlannedWrite?, touched: inout [String]) {
        guard let write else { return }
        // The plan was validated against the data before this list ran; an earlier data
        // action may have added a control (a repeat row) that refuses this value now.
        var next = state
        next[write.key] = write.value
        guard accepts(next) else { return }
        state[write.key] = write.value
        if !touched.contains(write.key) { touched.append(write.key) }
    }

    private mutating func runEmit(_ action: PrototypeAction) -> [PrototypeEvent] {
        let context = action.context?.resolve(EmitContextInputs(
            state: state,
            pages: pages,
            dataModel: data,
            platformModel: spec?.platformState,
            eventData: platformEventData
        ))
        return emit(kind: "emit", name: action.name, payload: action.payload ?? .null, context: context)
    }

    /// Runs `actions` in order, applying the writes planned for them.
    private mutating func execute(_ actions: [PrototypeAction], _ writes: [Int: PlannedWrite]) -> [PrototypeEvent] {
        let baseline = state
        var touched: [String] = []
        var events: [PrototypeEvent] = []
        for (index, action) in actions.enumerated() {
            guard isShown else { break }
            switch action.type {
            case "emit":
                events += runEmit(action)
            case "push", "pop", "popToRoot", "replace":
                events += runStack(action)
            case "setPage":
                events += runSetPage(action)
            case "setData", "appendData", "removeData":
                events += runDataWrite(action)
            case "startTimer":
                timerCommands.append(.start(action))
            case "cancelTimer":
                if let id = action.id { timerCommands.append(.cancel(id)) }
            case "request":
                events += runRequest(action)
            case "dismiss":
                events += dismiss(reason: .user)
            default:
                applyPlannedWrite(writes[index], touched: &touched)
            }
        }
        guard isShown else { return events }
        return events + emitStateChange(touched.filter { baseline[$0] != state[$0] })
    }

    /// A `setData`, `appendData` or `removeData` action (#12519). The write is applied to the shown
    /// spec's data with `PrototypeDataWrite`, the drawn tree is rebuilt from the changed data so
    /// bindings and repeat rows refresh, the data revision is bumped, and one `change` event named
    /// for the written `/data/...` path reports `{op, value?, revision}`. A refused write (any
    /// `PrototypeDataWriteCode`, or a tree the changed data cannot rebuild within the show's limits)
    /// changes and emits nothing, and the rest of the action list still runs.
    private mutating func runDataWrite(_ action: PrototypeAction) -> [PrototypeEvent] {
        guard let spec, let operation = PrototypeDataWrite.Operation(actionType: action.type),
              let path = action.path
        else {
            return []
        }
        let inputs = EmitContextInputs(
            state: state,
            pages: pages,
            dataModel: spec.data,
            platformModel: spec.platformState,
            eventData: platformEventData
        )
        var value: JSONValue?
        if operation != .remove {
            guard case let .success(resolved) = PrototypeDataWrite.resolveValue(action.value, inputs: inputs) else {
                return []
            }
            value = resolved
        }
        return (try? commitDataWrite(operation, path: path, value: value).get()) ?? []
    }

    /// Applies one data write to the shown spec: the data change, the rebuilt drawn tree, the
    /// bumped revision and the `change` event. A refused write changes nothing.
    private mutating func commitDataWrite(
        _ operation: PrototypeDataWrite.Operation, path: String, value: JSONValue?
    )
        -> Result<[PrototypeEvent], PrototypeDataWriteFailure>
    {
        guard let spec else { return .failure(.init(code: .notFound, message: "No prototype is shown")) }
        let data: [String: JSONValue]
        let maxItems = operation == .append || operation == .extend
            ? PrototypeLazyList.listMaxItems(spec: spec, dataPath: path) : nil
        switch PrototypeDataWrite.applyWindowed(
            spec.data,
            op: operation,
            path: path,
            value: value,
            maxItems: maxItems.map(Double.init)
        ) {
        case let .success(written): data = written.data
        case let .failure(failure): return .failure(failure)
        }
        guard let rebuilt = try? spec.replacingData(data) else {
            return .failure(.init(
                code: .limitExceeded, message: "\(path): the changed data breaks a limit the show enforces"
            ))
        }
        // The size baseline moves with the data the write changed, as it does for a patch, so a later
        // state write or patch is measured against the written spec rather than the shown one.
        let structureDelta = PrototypePatch.structureBytes(rebuilt) - PrototypePatch.structureBytes(spec)
        nonStateBytes = max(0, nonStateBytes + structureDelta)
        self.spec = rebuilt
        structureRevision += 1
        rebuildNavigation(for: rebuilt.root, keepingPages: pages, keepingStacks: stacks)
        let revision = dataRevision + 1
        revisions[rebuilt.id] = revision
        var payload: [String: JSONValue] = ["op": .string(operation.rawValue), "revision": .number(Double(revision))]
        if let maxItems { payload["maxItems"] = .number(Double(maxItems)) }
        // The value is left out when the event would not fit the emit payload limit, so the host,
        // which cannot mirror a write it was not shown, stops tracking the spec (as on Android).
        if let value, PrototypeEmitContext.fits(.object(payload.merging(["value": value]) { $1 })) {
            payload["value"] = value
        }
        return .success(emit(kind: "change", name: path, payload: .object(payload)))
    }

    /// Allocates one revision for the state keys `old` and the current state disagree on.
    private mutating func noteStateWrites(since old: [String: JSONValue]) {
        guard let id = spec?.id else { return }
        let changed = Set(old.keys).union(state.keys).filter { old[$0] != state[$0] }
        guard !changed.isEmpty else { return }
        let revision = (revisions[id] ?? 0) + 1
        revisions[id] = revision
        for key in changed {
            stateRevisions[key] = revision
        }
    }

    /// A host `patch_prototype` (#11675), mirroring Android's `PrototypeRuntime.patch`: state ops need a
    /// `baseRevision` and conflict on a key the user changed since it; the ops apply completely or not
    /// at all, and the result is validated like a show. An accepted patch is one new revision and one
    /// `change` event for the state keys it moved; pages and stack paths survive, text drafts follow
    /// the stored value. A refusal changes nothing.
    mutating func patch(id: String, baseRevision: Int?, ops: JSONValue) -> (PrototypePatchOutcome, [PrototypeEvent]) {
        guard let spec, spec.id == id else {
            return (.rejected(message: "Unknown prototype id: \(id)", revision: nil), [])
        }
        let current = dataRevision
        if let refusal = PrototypePatch.stateGuard(
            ops: ops, baseRevision: baseRevision, revision: current, stateRevisions: stateRevisions, state: state
        ) {
            return (refusal, [])
        }
        let patched: PrototypeSpec
        let newState: [String: JSONValue]
        switch PrototypePatch.rebuild(spec, state: state, ops: ops, nonStateBytes: nonStateBytes) {
        case let .success(result): (patched, newState) = result
        case let .failure(refusal): return (.rejected(message: refusal.message, revision: current), [])
        }
        let changed = Set(state.keys).union(newState.keys).filter { state[$0] != newState[$0] }.sorted()
        let revision = current + 1
        revisions[id] = revision
        tracksStateRevisions = false
        state = newState
        tracksStateRevisions = true
        for key in changed {
            stateRevisions[key] = revision
        }
        // The size baseline moves with the structure the patch changed, so a later state write or patch
        // is measured against the patched spec rather than the one the show measured (#13061).
        let structureDelta = PrototypePatch.structureBytes(patched) - PrototypePatch.structureBytes(spec)
        nonStateBytes = max(0, nonStateBytes + structureDelta)
        self.spec = patched
        structureRevision += 1
        rebuildNavigation(for: patched.root, keepingPages: pages, keepingStacks: stacks)
        return (.applied(revision: revision), emitStateChange(changed.filter { newState[$0] != nil }))
    }

    /// A `setPage` action: `next`/`prev` step from the current page, a number jumps to it.
    private mutating func runSetPage(_ action: PrototypeAction) -> [PrototypeEvent] {
        guard let pager = action.pager, let current = pages[pager] else { return [] }
        let target = switch action.page {
        case .string("next"): current + 1
        case .string("prev"): current - 1
        default: action.page?.intValue ?? current
        }
        return setPage(pager, target)
    }

    /// The key and value a state action writes given `state`, or nil when it writes nothing: a
    /// toggle of a non-boolean, or an increment/decrement of a non-number or to a non-finite value,
    /// is a no-op, as on Android's `stateWrite`.
    private func stateWrite(_ action: PrototypeAction, in state: [String: JSONValue]) -> PlannedWrite? {
        guard let key = action.key else { return nil }
        let next: JSONValue? = switch action.type {
        case "setState": action.value
        case "toggle": state[key]?.boolValue.map { .bool(!$0) }
        case "increment": stepped(state[key], by: action.incrementAmount ?? 1)
        case "decrement": stepped(state[key], by: -(action.incrementAmount ?? 1))
        default: nil
        }
        return next.map { (key, $0) }
    }

    private func stepped(_ value: JSONValue?, by step: Double) -> JSONValue? {
        guard let next = value?.numberValue.map({ $0 + step }), next.isFinite else { return nil }
        return .number(next)
    }

    /// One key keeps the `{key, value}` payload of `change`; several send `{keys, values}`. The
    /// event's `state` always carries the full final state.
    private mutating func emitStateChange(_ keys: [String]) -> [PrototypeEvent] {
        guard let first = keys.first else { return [] }
        showChangeErrors(keys)
        let payload: JSONValue = if keys.count == 1 {
            .object(["key": .string(first), "value": state[first] ?? .null])
        } else {
            .object([
                "keys": .array(keys.map(JSONValue.string)),
                "values": .object(Dictionary(uniqueKeysWithValues: keys.map { ($0, state[$0] ?? .null) })),
            ])
        }
        return emit(kind: "emit", name: "change", payload: payload).map {
            var event = $0
            event.isStateChange = true
            return event
        }
    }

    /// Several keys written together, reported by one `change` event (see `emitStateChange`). They are
    /// validated as one unit like any other interaction (#11562): a state that breaks a binding
    /// writes none of them.
    mutating func setStates(_ values: [(String, JSONValue)]) -> [PrototypeEvent] {
        control(own: values, then: [])
    }

    /// Test-hook tap (see `PrototypeTestHooks`): performs in-process what a real tap on the
    /// identified node or composite part (`<tag>.confirm`, `<tag>.<value>`, ...) does: a toggle
    /// flips its key, an option binds its value, a dialog button closes the dialog, anything else
    /// runs its `onTap`.
    mutating func simulateTap(identifier: String) -> Result<[PrototypeEvent], PrototypeTapFailure> {
        guard isShown, let spec else { return .failure(.notShown) }
        guard let target = spec.root.tapTarget(identifier: identifier, state: state, pages: pages, stacks: stacks)
        else {
            return .failure(.notFound)
        }
        guard let events = activate(target) else { return .failure(.notTappable) }
        return .success(events)
    }

    /// Settled pager position; clamped, and silent when the page does not change.
    mutating func setPage(_ pager: String, _ target: Int) -> [PrototypeEvent] {
        guard isShown, let pageCount = pageCounts[pager], pageCount >= 1 else { return [] }
        let clamped = min(max(target, 0), pageCount - 1)
        guard pages[pager] != clamped else { return [] }
        pages[pager] = clamped
        return emit(kind: "page_changed", name: pager, payload: .number(Double(clamped)))
    }

    /// The navigation fields shared by show and inspect/status results.
    var navigationSnapshot: [String: Any] {
        ["pages": pages, "stacks": stacks.mapValues(\.wireObject)]
    }

    var stackPopTarget: String? {
        guard let spec else { return nil }
        return PrototypeStacks.popTarget(root: spec.root, state: state, pages: pages, stacks: stacks)
    }

    func stackTransition(_ id: String) -> PrototypeStackTransition {
        PrototypeStackTransition(rawValue: stackNodes[id]?.transition ?? "") ?? .platform
    }

    mutating func popTopmostStack() -> [PrototypeEvent] {
        guard let id = stackPopTarget else { return [] }
        return changeStack(id, direction: .pop) { _, path in Array(path.dropLast()) }
    }

    private mutating func runStack(_ action: PrototypeAction) -> [PrototypeEvent] {
        guard let id = action.stack else { return [] }
        let direction: PrototypeStackChange.Direction = switch action.type {
        case "push": .push
        case "replace": .replace
        default: .pop
        }
        return changeStack(id, direction: direction, override: action.transition) { node, path in
            switch action.type {
            case "push":
                guard path.count < PrototypeLimits.maxStackDepth, let screen = action.screen,
                      node.screens?[screen] != nil else { return path }
                return path + [screen]
            case "pop":
                return path.count > 1 ? Array(path.dropLast()) : path
            case "popToRoot":
                return [node.start ?? ""]
            case "replace":
                guard let screen = action.screen, node.screens?[screen] != nil else { return path }
                return Array(path.dropLast()) + [screen]
            default:
                return path
            }
        }
    }

    private mutating func changeStack(
        _ id: String, direction: PrototypeStackChange.Direction, override: PrototypeStackTransition? = nil,
        transform: (PrototypeNode, [String]) -> [String]
    )
        -> [PrototypeEvent]
    {
        guard isShown, let node = stackNodes[id], let before = stacks[id] else { return [] }
        let path = transform(node, before.path)
        guard path != before.path, let screen = path.last else { return [] }
        let next = PrototypeStackSnapshot(path: path)
        stacks[id] = next
        stackRevision += 1
        stackChanges[id] = PrototypeStackChange(
            direction: direction,
            transition: override ?? PrototypeStackTransition(rawValue: node.transition ?? "") ?? .platform,
            revision: stackRevision
        )
        let retained = zip(before.path, path).prefix(while: { $0.0 == $0.1 }).count
        var entries = Array((stackEntries[id] ?? []).prefix(retained))
        for screen in path.dropFirst(entries.count) {
            nextStackEntry += 1
            entries.append(PrototypeStackEntry(id: nextStackEntry, screen: screen))
        }
        stackEntries[id] = entries
        // popToRoot can change a depth-one replacement back to start; repeated pushes of the
        // same screen change depth. Both are real changes, just as on Android.
        guard before.path.last != screen || before.depth != next.depth else { return [] }
        return emit(kind: "screen_changed", name: id, payload: .object([
            "screen": .string(screen), "depth": .number(Double(next.depth)),
        ]))
    }

    /// A user edit of a bound control: one `emit` named `change` per changed value, matching
    /// Android's `PrototypeRuntime.textChange`: validated against the bound controls and the spec byte
    /// cap (#11562), and dropped whole when rejected.
    mutating func change(key: String, value: JSONValue) -> [PrototypeEvent] {
        control(own: [(key, value)], then: [])
    }

    /// A `switch` or `checkbox` tap flips its bound boolean, then runs the node's own actions. A key
    /// that no longer holds a boolean leaves the control inert.
    mutating func toggle(key: String, then actions: [PrototypeAction]) -> [PrototypeEvent] {
        guard isShown, case let .bool(stored)? = state[key] else { return [] }
        return control(own: [(key, .bool(!stored))], then: actions)
    }

    /// A `tabBar`/`bottomNav` selection drives its pager when it has one, else its state key, then
    /// runs the node's `onTap` actions, as Android's selection does. The pager only moves once the
    /// action list is known to be accepted.
    mutating func select(
        index: Int,
        pager: String?,
        key: String?,
        then actions: [PrototypeAction] = []
    )
        -> [PrototypeEvent]
    {
        guard isShown else { return [] }
        guard let pager else {
            return control(own: key.map { [($0, .number(Double(index)))] } ?? [], then: actions)
        }
        if let failed = requireValid(actions) { return failed }
        guard let writes = plannedWrites(actions, from: state) else { return [] }
        return setPage(pager, index) + execute(actions, writes)
    }

    /// The terminal event: every dismissal emits exactly one `dismissed`, carrying its reason.
    mutating func dismiss(reason: PrototypeSessionDismissReason) -> [PrototypeEvent] {
        guard isShown else { return [] }
        let events = emit(kind: "dismissed", name: nil, payload: .object(["reason": .string(reason.rawValue)]))
        requests.cancelAll()
        timerCommands.append(.cancelAll)
        spec = nil
        return events
    }

    private mutating func emit(
        kind: String, name: String?, payload: JSONValue, context: PrototypeResolvedEmitContext? = nil
    )
        -> [PrototypeEvent]
    {
        guard let id = spec?.id else { return [] }
        let sequence = (sequences[id] ?? 0) + 1
        sequences[id] = sequence
        return [PrototypeEvent(
            id: id,
            sequence: sequence,
            wireKind: kind,
            name: name,
            payload: payload,
            state: state,
            pages: pages,
            stacks: stacks,
            resolvedContext: context,
            validity: kind == "emit" && name == "change" && !validity.isEmpty ? validity : nil
        )]
    }

    var validity: [String: Bool] {
        guard let spec else { return [:] }
        return PrototypeChecks.validity(PrototypeChecks.bindings(root: spec.root), state: state)
    }

    func isEnabled(_ node: PrototypeNode) -> Bool {
        node.enabledWhen?.holds(state) ?? true
    }

    func shownError(_ node: PrototypeNode) -> String? {
        for key in node.checkedKeys where shownErrors.contains(key) {
            let result = PrototypeChecks.evaluate(state[key], checks: node.checks ?? [], nodeType: node.type)
            if let message = result.firstFailingMessage { return message }
        }
        return nil
    }

    mutating func blur(_ node: PrototypeNode) {
        if (node.validateOn ?? .blur) == .blur { shownErrors.formUnion(node.checkedKeys) }
    }

    private mutating func showChangeErrors(_ keys: [String]) {
        func visit(_ node: PrototypeNode) -> [String] {
            let own = node.validateOn == .change ? node.checkedKeys.filter { keys.contains($0) } : []
            return own + ((node.children ?? []) + [node.child].compactMap { $0 }).flatMap(visit)
        }
        if let root = spec?.root { shownErrors.formUnion(visit(root)) }
    }

    /// Every guard reads pre-interaction state. Failure aborts own writes, actions and pages.
    private mutating func requireValid(_ actions: [PrototypeAction]) -> [PrototypeEvent]? {
        let validity = validity
        let failed = actions.prefix { $0.type != "dismiss" }.filter {
            $0.type == "emit" && ($0.requireValid?.contains { validity[$0] != true } ?? false)
        }
        guard !failed.isEmpty else { return nil }
        var events: [PrototypeEvent] = []
        for action in failed {
            let keys = action.requireValid ?? []
            shownErrors.formUnion(keys)
            var emitted = emit(kind: "validation_failed", name: action.name, payload: .null)
            for index in emitted.indices {
                emitted[index].keys = keys.filter { validity[$0] != true }
            }
            events += emitted
        }
        return events
    }

    // MARK: Status

    /// Font asset ids the shown spec names. Fonts are reported missing and drawn with the system
    /// font unless the viewer registered a face for the asset.
    func fontAssets() -> [String] {
        guard let spec else { return [] }
        var ids = Set<String>()
        spec.root.collectFontAssets(into: &ids)
        return ids.sorted()
    }

    func missingAssets(available: Set<String>) -> [String] {
        guard let spec else { return [] }
        var ids = Set<String>()
        spec.root.collectAssets(into: &ids)
        return ids.subtracting(available).sorted()
    }
}

extension PrototypeNode {
    /// Pager ids and their page counts, so `setPage` can clamp without consulting the view tree.
    func pagerCounts() -> [String: Int] {
        var counts: [String: Int] = [:]
        collectPagers(into: &counts)
        return counts
    }
}

/// Why `simulate_tap` did nothing.
enum PrototypeTapFailure: Error, Equatable {
    case notShown
    case notFound
    case notTappable
}

/// Debug-only protocol surface for headless tests, where there is no input path into the
/// simulator. Enabled only when the host sets the flag at launch; production `launchApp` never does.
enum PrototypeTestHooks {
    static let environmentKey = "AUTOMOBILE_PROTOTYPE_AGENT_TEST_HOOKS"
    static let gatedRequestTypes: Set<String> = ["simulate_tap"]

    static func isEnabled(environment: [String: String]) -> Bool {
        environment[environmentKey] == "1"
    }

    /// Capabilities to advertise in `hello_result`: the test hooks are listed only when enabled,
    /// because the host client refuses to send a request type the agent does not advertise.
    static func capabilities(enabled: Bool) -> [String] {
        let advertised = PrototypeAgentProtocol.advertisedCapabilities()
        return enabled ? advertised + gatedRequestTypes.sorted() : advertised
    }

    /// The error to reply with when `requestType` is a test hook and hooks are off; nil otherwise.
    static func rejection(requestType: String, enabled: Bool) -> String? {
        guard gatedRequestTypes.contains(requestType), !enabled else { return nil }
        return "\(requestType) is a test hook; launch the app with \(environmentKey)=1 to enable it"
    }
}

// MARK: Requests (#12529)

extension PrototypeSession {
    /// The commands for the request driver since the last call. A transition calls this on its new
    /// value before it is stored, so the driver sees exactly what that transition started or ended.
    mutating func takeRequestCommands() -> [PrototypeRequestCommand] {
        requests.takeCommands()
    }

    /// A `request` action. Bindings resolve against the committed state and data; a request that
    /// cannot be built or is refused completes at once as an error. Otherwise the status key moves
    /// to `loading` and a start command is issued; the response arrives later through
    /// `completeRequest`. Starting a request cancels older requests with overlapping write targets
    /// (the latest wins).
    private mutating func runRequest(_ action: PrototypeAction) -> [PrototypeEvent] {
        guard let spec else { return [] }
        let inputs = EmitContextInputs(
            state: state,
            pages: pages,
            dataModel: spec.data,
            platformModel: spec.platformState,
            eventData: platformEventData
        )
        var events: [PrototypeEvent] = []
        let into = action.into
        let targets = [into, action.append?.to].compactMap { $0 }
        for older in requests.inFlight(overlapping: targets) {
            let target = targets.first { target in
                [older.into, older.append?.to].compactMap { $0 }.contains { path in
                    path == target || path.hasPrefix("\(target)/") || target.hasPrefix("\(path)/")
                }
            } ?? targets.first ?? ""
            events += cancelRequest(older, message: "Superseded by a newer request to \(target)")
        }
        let urlText = PrototypeRequestResolver.urlText(action, inputs: inputs)
        let resolved = PrototypeRequestResolver.resolve(action, urlText: urlText, inputs: inputs)
        // A request that failed to resolve still reports the method and URL text it tried.
        let request = (try? resolved.get()) ?? PrototypeResolvedRequest(
            method: action.method.flatMap(PrototypeRequestMethod.init(rawValue:)) ?? .get,
            url: urlText, headers: [:], body: nil
        )
        let job = PrototypeRequestJob(
            requestId: requests.nextId(),
            prototypeId: spec.id,
            via: action.via.flatMap(PrototypeRequestVia.init(rawValue:)) ?? .host,
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: request.body,
            timeoutMs: action.timeoutMs.flatMap { Int(exactly: $0) }
        )
        let inFlight = PrototypeInFlightRequest(
            job: job,
            into: into,
            statusKey: action.statusKey,
            onSuccess: action.onSuccess ?? [],
            onError: action.onError ?? [],
            append: action.append
        )
        if case let .failure(error) = resolved {
            return events + finishRequest(inFlight, .failed(error, durationMs: 0))
        }
        if requests.inFlight.count >= PrototypeLimits.maxRequestsInFlight {
            let error = PrototypeRequestError(
                .tooManyInFlight,
                "At most \(PrototypeLimits.maxRequestsInFlight) requests may be in flight at once."
            )
            return events + finishRequest(inFlight, .failed(error, durationMs: 0))
        }
        requests.start(inFlight)
        return events + writeRequestStatus(inFlight.statusKey, "loading")
    }

    /// A response (or failure) for a request this session started. A request that was cancelled,
    /// belongs to a prototype that is gone, or never existed changes and emits nothing.
    mutating func completeRequest(_ requestId: String, _ response: PrototypeRequestResponse) -> [PrototypeEvent] {
        guard isShown, let inFlight = requests.finish(requestId), inFlight.job.prototypeId == spec?.id else {
            return []
        }
        return finishRequest(inFlight, response)
    }

    /// The `applyPrototypeRequestOutcome` order: the body at `into`, the metadata at
    /// `<into>__meta`, the status key, the request event, then the follow-up list.
    private mutating func finishRequest(
        _ inFlight: PrototypeInFlightRequest, _ response: PrototypeRequestResponse
    )
        -> [PrototypeEvent]
    {
        if inFlight.append != nil { return finishAppendRequest(inFlight, response) }
        var meta = PrototypeRequestMeta(response)
        var events: [PrototypeEvent] = []
        var minimalMeta = false
        let saved = self
        var wroteBody = false
        if case let .received(_, _, body, _) = response, meta.error == nil, let into = inFlight.into {
            let stored = PrototypeRequestOutcome.storedBody(body, method: inFlight.job.method)
            if leavesNoRoomForMeta(stored, into: into, meta: meta) {
                // The completion is atomic: a body that fits without room for any `__meta` is not
                // written, and the request is an error whose minimal metadata is written if it fits.
                meta.error = PrototypeRequestError(.invalidResponse, PrototypeRequestOutcome.noRoomForMeta)
                minimalMeta = true
            } else {
                switch commitDataWrite(.set, path: into, value: stored) {
                case let .success(written):
                    events += written
                    wroteBody = true
                case let .failure(failure): meta.error = PrototypeRequestError(.invalidResponse, failure.message)
                }
            }
        }
        if let into = inFlight.into {
            if let written = writeRequestMeta(meta, beside: into, minimal: minimalMeta) {
                events += written
            } else if wroteBody {
                // The pure preflight passed but the drawn tree refused every form of `__meta` (a bound
                // field, such as substituted text, outgrew its limit): roll the body back too.
                self = saved
                events = []
                meta.error = PrototypeRequestError(.invalidResponse, PrototypeRequestOutcome.noRoomForMeta)
                events += writeRequestMeta(meta, beside: into, minimal: true) ?? []
            }
        }
        let failed = meta.error != nil
        events += writeRequestStatus(inFlight.statusKey, failed ? "error" : "success")
        events += emit(
            kind: "emit",
            name: PrototypeRequestEvent.name,
            payload: PrototypeRequestEvent.payload(job: inFlight.job, into: inFlight.into, meta: meta)
        )
        return events + run(failed ? inFlight.onError : inFlight.onSuccess)
    }

    /// The `__meta` values to try, in order: whole, without `headers`, and (only when `minimal`)
    /// reduced to the duration and error.
    private func metaForms(_ meta: PrototypeRequestMeta, minimal: Bool) -> [JSONValue] {
        var forms = [meta.json(includingHeaders: true)]
        if meta.headers != nil { forms.append(meta.json(includingHeaders: false)) }
        if minimal, let error = meta.error {
            forms.append(PrototypeRequestMeta(.failed(error, durationMs: meta.durationMs)).json())
        }
        return forms
    }

    /// Whether the body would fit at `into` but no form of `<into>__meta` would fit beside it.
    private func leavesNoRoomForMeta(_ stored: JSONValue, into: String, meta: PrototypeRequestMeta) -> Bool {
        guard case let .success(withBody) = PrototypeDataWrite.apply(spec?.data, op: .set, path: into, value: stored)
        else { return false }
        return !metaForms(meta, minimal: false).contains { form in
            if case .success = PrototypeDataWrite.apply(withBody, op: .set, path: into + "__meta", value: form) {
                return true
            }
            return false
        }
    }

    /// `<into>__meta` in the first form that fits the data write limit.
    private mutating func writeRequestMeta(
        _ meta: PrototypeRequestMeta, beside into: String, minimal: Bool
    )
        -> [PrototypeEvent]?
    {
        for form in metaForms(meta, minimal: minimal) {
            if case let .success(events) = commitDataWrite(.set, path: into + "__meta", value: form) {
                return events
            }
        }
        return nil
    }

    /// Moves the status key to `loading`, `success` or `error`. Nothing is written for an
    /// undeclared or non-string key, or a value some control bound to the key would refuse.
    private mutating func writeRequestStatus(_ key: String?, _ status: String) -> [PrototypeEvent] {
        guard let key, state[key]?.stringValue != nil, state[key] != .string(status) else { return [] }
        var next = state
        next[key] = .string(status)
        guard accepts(next) else { return [] }
        state[key] = .string(status)
        return emitStateChange([key])
    }

    /// Ends a request that a newer one replaces: nothing is written, the status key keeps its
    /// value and no follow-up runs, but the request event reports `cancelled`. There is no clock in
    /// the session, so its `durationMs` is 0.
    private mutating func cancelRequest(_ older: PrototypeInFlightRequest, message: String) -> [PrototypeEvent] {
        requests.cancel(older.job.requestId)
        let meta = PrototypeRequestMeta(.failed(PrototypeRequestError(.cancelled, message), durationMs: 0))
        return emit(
            kind: "emit",
            name: PrototypeRequestEvent.name,
            payload: PrototypeRequestEvent.payload(job: older.job, into: older.into, meta: meta)
        )
    }
}

/// Value snapshots keep pure lookups independent of the session's mutation machinery.
private struct EmitContextInputs: PrototypeEmitContextInputs {
    let state: [String: JSONValue]
    let pages: [String: Int]
    let dataModel: [String: JSONValue]?
    var platformModel: [String: JSONValue]?
    var eventData: JSONValue?

    func platform(_ pointer: String) -> JSONValue? { PrototypeDataPointer.resolve(platformModel, pointer: pointer) }
    func event(_ pointer: String) -> JSONValue? {
        eventData.flatMap { PrototypeDataPointer.resolve($0, tokens: PrototypeDataPointer.tokens(pointer)[...]) }
    }

    func state(_ key: String) -> JSONValue? { state[key] }
    func page(_ id: String) -> Int? { pages[id] }
    func data(_ pointer: String) -> JSONValue? { PrototypeDataPointer.resolve(dataModel, pointer: pointer) }
}

extension PrototypeSession {
    /// Both visibility and content changes enter the same synchronous session transition.
    mutating func listVisible(
        _ node: PrototypeNode,
        appearedKey: String? = nil,
        disappearedKey: String? = nil
    )
        -> [PrototypeEvent]
    {
        guard isShown, let actions = node.onEndReached else { return [] }
        let keys = PrototypeLazyList.keys(node: node, data: data)
        var driver = listEnds[node.nodePath] ?? PrototypeListEndDriver(endThreshold: node.endThreshold ?? 3)
        let fires = driver.update(appearedKey: appearedKey, disappearedKey: disappearedKey, rowKeys: keys)
        listEnds[node.nodePath] = driver
        return fires ? run(actions) : []
    }

    /// Preflight with the shared outcome, then stage replayable writes on a value copy. No await or
    /// external callback can interleave a host data write between the append and its metadata.
    private mutating func finishAppendRequest(
        _ request: PrototypeInFlightRequest, _ response: PrototypeRequestResponse
    )
        -> [PrototypeEvent]
    {
        guard let spec, var append = request.append else { return [] }
        append.maxItems = PrototypeLazyList.listMaxItems(spec: spec, dataPath: append.to).map(Double.init)
        let outcome = PrototypeRequestOutcome.apply(
            spec.data ?? [:],
            into: request.into,
            response: response,
            append: append
        )
        var meta = outcome.meta
        var staged = self
        var events: [PrototypeEvent] = []
        do {
            if outcome.status == "success", case let .received(_, _, body, _) = response {
                let items = PrototypeDataPointer.resolve(body, tokens: PrototypeDataPointer.tokens(append.from)[...])
                switch staged.commitDataWrite(.extend, path: append.to, value: items) {
                case let .success(written): events += written
                case let .failure(error): throw PrototypeRequestError(.invalidResponse, "append.to \(error.message)")
                }
                if let into = request.into, let pointer = PrototypeDataWrite.pointer(ofPath: into) {
                    let rest = PrototypeDataPointer.resolve(outcome.data, pointer: pointer)
                    events += try staged.commitDataWrite(.set, path: into, value: rest).get()
                }
            }
            if let into = request.into {
                guard let written = staged.writeRequestMeta(meta, beside: into, minimal: outcome.status == "error")
                else { throw PrototypeRequestError(.invalidResponse, PrototypeRequestOutcome.noRoomForMeta) }
                events += written
            }
            self = staged
        } catch {
            events = []
            if let requestError = error as? PrototypeRequestError { meta.error = requestError }
            else if let writeError = error as? PrototypeDataWriteFailure {
                meta.error = .init(.invalidResponse, writeError.message)
            } else {
                requestCompletionLog
                    .warning("Request append completion failed: \(String(describing: error), privacy: .private)")
                meta.error = .init(.invalidResponse, "Request append completion could not rebuild the prototype")
            }
            if let into = request.into { events += writeRequestMeta(meta, beside: into, minimal: true) ?? [] }
        }
        let failed = meta.error != nil
        events += writeRequestStatus(request.statusKey, failed ? "error" : "success")
        events += emit(
            kind: "emit",
            name: PrototypeRequestEvent.name,
            payload: PrototypeRequestEvent.payload(job: request.job, into: request.into, meta: meta)
        )
        return events + run(failed ? request.onError : request.onSuccess)
    }
}
