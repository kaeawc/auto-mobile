import Foundation

/// The deterministic fake media engine (#14257), the twin of TypeScript's and Kotlin's
/// `PrototypeFakeMediaEngine`. All three replay `test/fixtures/prototype-media-sim`.
///
/// Nothing decodes. Time is virtual: it moves only when the runtime's injected clock calls `advance`,
/// so a playing player's position, end of media and looping are exact. `simulate` applies a `media.*`
/// event from `prototype simulate`. Events are reported only on status or `playing` transitions, never
/// on position ticks, and `buffering` stalls the playhead without one.
final class PrototypeFakeMediaEngine {
    /// One player's `/platform/media/players/<id>` state; `error` is set only in `error`.
    struct State: Equatable, Sendable {
        var playing: Bool
        var positionMs: Int
        var durationMs: Int
        var buffering: Bool
        var status: String
        var error: String?
    }

    struct Event: Equatable, Sendable {
        let name: String
        let payload: [String: JSONValue]
    }

    struct SimRequest: Equatable, Sendable {
        let event: String
        let player: String
        /// `media.statusChanged` only.
        var status: String?
        /// Required when the event drives the player into `error`.
        var code: String?
        /// Advance the virtual clock by this much before applying the event.
        var advanceMs: Int?
    }

    enum Failure: String, Error, Equatable, Sendable {
        case unknownPlayer = "unknown_player"
        case invalidArgs = "invalid_args"
    }

    /// The statuses `media.statusChanged` can drive a fake player into.
    static let simStatuses = [buffering, ready, ended, error]

    /// The media module's stable error codes, from the contract's `/platform/media` state.
    static let errorCodes: [String] = {
        let values = PrototypeContractValidator.platformModules["media"]?.objectFields?["state"]?
            .objectFields?["error"]?.objectFields?["value"]?.objectFields?["values"]
        guard case let .array(items)? = values else { return [] }
        return items.compactMap(\.stringValue)
    }()

    private static let buffering = "buffering"
    private static let ready = "ready"
    private static let ended = "ended"
    private static let error = "error"

    private struct Player {
        var state: State
        let loop: Bool
    }

    private var order: [String] = []
    private var players: [String: Player] = [:]
    private(set) var events: [Event] = []

    /// `/platform/media/players`: every loaded player's state, in load order.
    func snapshot() -> [(id: String, state: State)] {
        order.compactMap { id in players[id].map { (id: id, state: $0.state) } }
    }

    /// Load a player paused at 0; `durationMs` is `-1` when the source has no known end.
    func load(_ player: String, durationMs: Int, loop: Bool = false) {
        let state = State(playing: false, positionMs: 0, durationMs: durationMs, buffering: false, status: Self.ready)
        if players[player] == nil { order.append(player) }
        players[player] = Player(state: state, loop: loop)
        statusChanged(player, state)
    }

    func play(_ player: String) -> Failure? {
        update(player) { state in
            if state.status == Self.error { return }
            if state.status == Self.ended {
                state.positionMs = 0
                state.status = Self.ready
            }
            state.playing = true
        }
    }

    func pause(_ player: String) -> Failure? {
        update(player) { $0.playing = false }
    }

    func seek(_ player: String, positionMs: Int) -> Failure? {
        update(player) { state in
            if state.status == Self.error { return }
            let end = state.durationMs >= 0 ? state.durationMs : Int.max
            state.positionMs = min(max(0, positionMs), end)
            if state.status == Self.ended, state.positionMs < end { state.status = Self.ready }
        }
    }

    /// Move the virtual clock: playing, ready, non-buffering players advance, end or loop.
    func advance(_ ms: Int) {
        for id in order {
            guard var entry = players[id] else { continue }
            let state = entry.state
            if !state.playing || state.buffering || state.status != Self.ready { continue }
            let position = state.positionMs + ms
            if state.durationMs < 0 || position < state.durationMs {
                entry.state.positionMs = position
                players[id] = entry
            } else if entry.loop {
                entry.state.positionMs = state.durationMs == 0 ? 0 : position % state.durationMs
                players[id] = entry
            } else {
                entry.state.positionMs = position
                players[id] = entry
                end(id)
            }
        }
    }

    func simulate(_ request: SimRequest) -> Failure? {
        guard players[request.player] != nil else { return .unknownPlayer }
        let status: String? = switch request.event {
        case "media.ended": Self.ended
        case "media.error": Self.error
        case "media.statusChanged": request.status.flatMap { Self.simStatuses.contains($0) ? $0 : nil }
        default: nil
        }
        guard let status, status != Self.error || Self.errorCodes.contains(request.code ?? "") else {
            return .invalidArgs
        }
        if let advanceMs = request.advanceMs { advance(advanceMs) }
        switch status {
        case Self.buffering:
            players[request.player]?.state.buffering = true
        case Self.ready:
            _ = update(request.player) { state in
                state.buffering = false
                state.status = Self.ready
                state.error = nil
            }
        case Self.ended:
            players[request.player]?.state.buffering = false
            end(request.player)
        default:
            fail(request.player, code: request.code ?? "")
        }
        return nil
    }

    func release(_ player: String) -> Failure? {
        guard players.removeValue(forKey: player) != nil else { return .unknownPlayer }
        order.removeAll { $0 == player }
        return nil
    }

    private func update(_ player: String, _ change: (inout State) -> Void) -> Failure? {
        guard let before = players[player]?.state else { return .unknownPlayer }
        var after = before
        change(&after)
        players[player]?.state = after
        if before.status != after.status || before.playing != after.playing {
            statusChanged(player, after)
        }
        return nil
    }

    private func end(_ player: String) {
        let wasEnded = players[player]?.state.status == Self.ended
        _ = update(player) { state in
            state.playing = false
            if state.durationMs >= 0 { state.positionMs = state.durationMs }
            state.status = Self.ended
            state.error = nil
        }
        if !wasEnded { events.append(Event(name: "media.ended", payload: ["player": .string(player)])) }
    }

    private func fail(_ player: String, code: String) {
        let state = players[player]?.state
        let unchanged = state?.status == Self.error && state?.error == code
        _ = update(player) { state in
            state.playing = false
            state.buffering = false
            state.status = Self.error
            state.error = code
        }
        if !unchanged {
            events.append(Event(name: "media.error", payload: ["player": .string(player), "code": .string(code)]))
        }
    }

    private func statusChanged(_ player: String, _ state: State) {
        events.append(Event(name: "media.statusChanged", payload: [
            "player": .string(player),
            "status": .string(state.status),
            "playing": .bool(state.playing),
            "positionMs": .number(Double(state.positionMs)),
        ]))
    }
}
