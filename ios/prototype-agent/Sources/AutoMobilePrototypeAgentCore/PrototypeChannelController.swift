import Foundation

/// Access is exclusively through the module's non-reentrant ordered inbox, including timers and
/// callbacks. That inbox is the controller's outer lock; only sink.commit enters the runtime.
@MainActor
final class PrototypeChannelController {
    final class Slot {
        let id: String
        let declaration: [String: JSONValue]
        var status = "idle"
        var attempt = 0
        var framesIn = 0
        var framesDropped = 0
        var closeCode: Int?
        var closeReason: String?
        var error: PrototypeChannelError?
        var generation = 0
        var connection: (any PrototypeChannelConnection)?
        var lastEventID: String?
        var timer: (any PrototypeTimerHandle)?
        var queue: [String] = []
        var active: Bool { ["connecting", "open", "reconnecting"].contains(status) }
        var snapshot: JSONValue {
            var value: [String: JSONValue] = [
                "status": .string(status), "attempt": .number(Double(attempt)),
                "framesIn": .number(Double(framesIn)), "framesDropped": .number(Double(framesDropped)),
            ]
            if let closeCode { value["closeCode"] = .number(Double(closeCode)) }
            if let closeReason { value["closeReason"] = .string(closeReason) }
            if let error { value["error"] = error.json }
            return .object(value)
        }

        var event: JSONValue {
            .object((snapshot.objectFields ?? [:]).merging(["channel": .string(id)]) { _, new in new })
        }

        init(_ id: String, _ declaration: [String: JSONValue]) {
            self.id = id
            self.declaration = declaration
        }
    }

    struct Routed {
        let slot: Slot
        let actions: [JSONValue]
        let event: JSONValue
    }

    private let prototypeID: String
    private let config: PrototypeRealtimeConfig
    private let sink: PrototypeChannelSink
    private let clock: any PrototypeClock
    var post: (@escaping @MainActor () async throws -> Void) -> Void = { _ in }
    private var slots: [String: Slot] = [:]
    private var window: [Routed] = []
    private var dirty: Set<String> = []
    private var flush: (any PrototypeTimerHandle)?
    private var started = false
    private(set) var closing = false

    init(prototypeID: String, config: PrototypeRealtimeConfig, sink: PrototypeChannelSink, clock: any PrototypeClock) {
        self.prototypeID = prototypeID
        self.config = config
        self.sink = sink
        self.clock = clock
    }

    // No lock acquisition here: dismissal suppresses queued work immediately.
    func beginClose() { closing = true }

    func update(_ channels: [String: JSONValue]) async throws {
        guard !closing else { return }
        for id in slots.keys.sorted() where channels[id] == nil {
            if let old = slots.removeValue(forKey: id) { abandon(old) }
        }
        for id in channels.keys.sorted() {
            guard let declaration = channels[id]?.objectFields else { continue }
            let old = slots[id]
            if let old, PrototypePatch.equal(.object(old.declaration), .object(declaration)) { continue }
            let live = old?.active == true
            if let old { abandon(old) }
            let slot = Slot(id, declaration)
            slots[id] = slot
            try await publish(slot)
            if live || (old == nil && started && declaration["connect"] != .string("manual")) {
                try await connect(slot)
            }
        }
    }

    func show() async throws {
        guard !closing, !started else { return }
        started = true
        for id in slots.keys.sorted() {
            guard let slot = slots[id], slot.status == "idle", slot.declaration["connect"] != .string("manual")
            else { continue }
            try await connect(slot)
        }
    }

    func call(_ call: PlatformCall) async throws -> PlatformCallResult {
        guard !closing else { return .failure(.cancelled, "The channels are closed") }
        guard let id = call.args["channel"]?.stringValue, let slot = slots[id] else {
            return .failure(.invalidArgs, "Channel is not declared")
        }
        switch call.call {
        case "realtime.connect":
            if !slot.active { slot.attempt = 0; try await connect(slot) }
        case "realtime.disconnect":
            if slot.active {
                end(slot)
                slot.connection?.close(code: 1000, reason: "")
                slot.connection = nil
                slot.closeCode = 1000
                slot.closeReason = ""
                try await status(slot, "closed")
            }
        case "realtime.send": return send(slot, body: call.args["body"])
        default: return .failure(.unsupported, "Unknown realtime call")
        }
        return .success(.object([:]))
    }

    func close() {
        closing = true
        flush?.cancel()
        flush = nil
        window = []
        dirty = []
        slots.values.forEach { abandon($0) }
        slots = [:]
    }

    private func send(_ slot: Slot, body: JSONValue?) -> PlatformCallResult {
        guard slot.declaration["kind"] == .string("websocket"), let body else {
            return .failure(.invalidArgs, "realtime.send requires a websocket and body")
        }
        let text: String
        if let raw = body.stringValue { text = raw }
        else {
            guard let bytes = try? JSONEncoder().encode(body), let raw = String(data: bytes, encoding: .utf8)
            else { return .failure(.invalidArgs, "Body is not JSON") }
            text = raw
        }
        guard text.utf8.count <= PrototypeChannelLimits.maxSendBytes else {
            return .failure(.platformError, "Send exceeds maxSendBytes")
        }
        if slot.status == "open" {
            return slot.connection?.send(text) == true ? .success(.object([:])) : .failure(.platformError, "network")
        }
        if slot.status == "connecting" || slot.status == "reconnecting" {
            guard slot.queue.count < 32 else { return .failure(.tooManyInFlight, "At most 32 sends may wait") }
            slot.queue.append(text)
            return .success(.object([:]))
        }
        return .failure(.platformError, "Channel is not connected")
    }

    private func connect(_ slot: Slot) async throws {
        slot.closeCode = nil
        slot.closeReason = nil
        slot.error = nil
        try await status(slot, slot.attempt == 0 ? "connecting" : "reconnecting")
        try await open(slot)
    }

    private func open(_ slot: Slot) async throws {
        guard !closing else { return }
        slot.generation += 1
        let generation = slot.generation
        let listener = PrototypeChannelListener(
            opened: { [weak self, weak slot] in self?.enqueue(slot, generation) { try await $0.opened($1) } },
            frame: { [weak self, weak slot] text, event, id in
                self?.enqueue(slot, generation) { try await $0.received($1, text: text, event: event, id: id) }
            },
            closed: { [weak self, weak slot] code, reason, error in
                self?.enqueue(slot, generation) { try await $0.ended($1, code: code, reason: reason, error: error) }
            }
        )
        let request = PrototypeChannelOpenRequest(
            connectionID: config.newID(), prototypeID: prototypeID, channel: slot.id,
            declaration: slot.declaration,
            lastEventID: slot.declaration["kind"] == .string("sse") ? slot.lastEventID : nil
        )
        let transport = slot.declaration["via"] == .string("device") ? config.device : config.host
        do {
            slot.connection = try transport.open(request, listener: listener)
        } catch {
            try await ended(slot, code: nil, reason: nil, error: PrototypeChannelError(
                code: "network", message: String(describing: error)
            ))
        }
    }

    private func enqueue(
        _ slot: Slot?, _ generation: Int,
        _ work: @escaping @MainActor (PrototypeChannelController, Slot) async throws -> Void
    ) {
        guard let slot else { return }
        post { [weak self, weak slot] in
            guard let self, let slot, !closing, slots[slot.id] === slot, slot.generation == generation else { return }
            try await work(self, slot)
        }
    }

    private func opened(_ slot: Slot) async throws {
        try await status(slot, "open")
        for text in slot.queue {
            _ = slot.connection?.send(text)
        }
        slot.queue = []
        let generation = slot.generation
        slot.timer = timer(5000) { [weak self, weak slot] in
            guard let self, let slot, slot.generation == generation else { return }
            slot.attempt = 0
            try await publish(slot)
        }
        try await callback(slot, "onOpen")
    }

    private func received(_ slot: Slot, text: String, event: String?, id: String?) async throws {
        if let id { slot.lastEventID = id }
        dirty.insert(slot.id)
        defer { scheduleFlush() }
        guard text.utf8.count <= PrototypeChannelLimits.maxFrameBytes else { slot.framesDropped += 1; return }
        let decoded: JSONValue
        if slot.declaration["decode"] == .string("text") { decoded = .string(text) }
        else {
            guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
            else { slot.framesDropped += 1; return }
            decoded = value
        }
        slot.framesIn += 1
        var fields: [String: JSONValue] = ["channel": .string(slot.id), "data": decoded]
        if let event { fields["event"] = .string(event) }
        if let id { fields["id"] = .string(id) }
        try await sink.commit(.init(
            channel: slot.id, declaration: slot.declaration, eventName: "realtime.frame", event: .object(fields)
        ))
        if let actions = PrototypeChannelRoutes.match(slot.declaration["routes"], data: decoded, event: event) {
            window.append(.init(slot: slot, actions: actions, event: decoded))
        }
    }

    private func scheduleFlush() {
        guard flush == nil, !closing else { return }
        flush = timer(PrototypeChannelLimits.flushMs) { [weak self] in try await self?.flushWindow() }
    }

    private func flushWindow() async throws {
        flush = nil
        let frames = window.filter { slots[$0.slot.id] === $0.slot }
        window = []
        for index in PrototypeChannelCoalescer.keptIndices(frames.map(\.actions)) {
            let frame = frames[index]
            try await sink.commit(.init(
                channel: frame.slot.id, declaration: frame.slot.declaration,
                event: frame.event, actions: frame.actions
            ))
        }
        let changed = dirty.sorted()
        dirty = []
        for id in changed {
            if let slot = slots[id] { try await publish(slot) }
        }
    }

    private func ended(_ slot: Slot, code: Int?, reason: String?, error: PrototypeChannelError?) async throws {
        slot.timer?.cancel()
        slot.connection = nil
        slot.closeCode = code
        slot.closeReason = reason
        slot.error = error
        let callbackName = error == nil ? "onClose" : "onError"
        let reconnect = slot.declaration["reconnect"]?.objectFields ?? [:]
        let next = slot.attempt + 1
        let delay = PrototypeChannelBackoff.delayMs(
            attempt: next, maxAttempts: reconnect["maxAttempts"]?.numberValue.map(Int.init),
            initialDelayMs: reconnect["initialDelayMs"]?.numberValue.map(Int.init),
            maxDelayMs: reconnect["maxDelayMs"]?.numberValue.map(Int.init), random: config.random
        )
        if delay == nil {
            slot.queue = []
            try await status(slot, error == nil ? "closed" : "error")
        } else if let delay {
            slot.attempt = next
            try await status(slot, "reconnecting")
            let generation = slot.generation
            slot.timer = timer(delay) { [weak self, weak slot] in
                guard let self, let slot, slot.generation == generation else { return }
                try await open(slot)
            }
        }
        try await callback(slot, callbackName)
    }

    private func status(_ slot: Slot, _ value: String) async throws {
        let changed = slot.status != value
        slot.status = value
        var actions: [JSONValue] = []
        if changed, let key = slot.declaration["statusKey"] {
            actions = [.object(["type": .string("setState"), "key": key, "value": .string(value)])]
        }
        try await sink.commit(.init(
            channel: slot.id, declaration: slot.declaration, state: slot.snapshot,
            eventName: changed ? "realtime.status" : nil, event: slot.event, actions: actions
        ))
    }

    private func publish(_ slot: Slot) async throws {
        try await sink.commit(.init(channel: slot.id, declaration: slot.declaration, state: slot.snapshot))
    }

    private func callback(_ slot: Slot, _ name: String) async throws {
        guard case let .array(actions)? = slot.declaration[name] else { return }
        try await sink.commit(.init(
            channel: slot.id, declaration: slot.declaration, event: slot.event, actions: actions
        ))
    }

    private func end(_ slot: Slot) {
        slot.generation += 1
        slot.timer?.cancel()
        slot.timer = nil
        slot.queue = []
        slot.attempt = 0
    }

    private func abandon(_ slot: Slot) {
        end(slot)
        slot.connection?.close(code: 1001, reason: "")
        slot.connection = nil
    }

    private func timer(_ delay: Int, _ work: @escaping @MainActor () async throws -> Void) -> any PrototypeTimerHandle {
        clock.schedule(afterMilliseconds: delay) { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.post { [weak self] in
                    guard self?.closing == false else { return }
                    try await work()
                }
            }
        }
    }
}
