import Foundation

enum PrototypeTimerCommand {
    case start(PrototypeAction)
    case cancel(String)
    case cancelAll
}

struct PrototypeTimerSnapshot: Equatable {
    let id: String
    let nextFireInMs: Int
    let runs: Int

    var wireObject: [String: Any] { ["id": id, "nextFireInMs": nextFireInMs, "runs": runs] }
}

/// One scheduler for the prototype's timers. Generations make cancellation/replacement during a
/// callback safe; callbacks run synchronously through the session's atomic interaction path.
final class PrototypeTimers {
    struct AdvanceResult: Equatable {
        let fired: Int
        let error: String?
    }

    private struct Entry {
        let action: PrototypeAction
        let order: Int
        var nextFireAt: Int
        var runs = 0
    }

    private let clock: PrototypeClock
    private let fire: ([PrototypeAction]) -> Void
    private var entries: [String: Entry] = [:]
    private var handle: PrototypeTimerHandle?
    private var order = 0
    private var offset = 0
    private var pausedAt: Int?
    private var firingAt: Int?
    private var draining = false

    init(clock: PrototypeClock, fire: @escaping ([PrototypeAction]) -> Void) {
        self.clock = clock
        self.fire = fire
    }

    deinit { handle?.cancel() }

    private var now: Int { firingAt ?? pausedAt ?? (clock.nowMilliseconds + offset) }

    func perform(_ commands: [PrototypeTimerCommand]) {
        for command in commands {
            switch command {
            case let .start(action):
                guard let id = action.id, !id.isEmpty, let delay = action.afterMs,
                      delay >= 100, entries[id] != nil || entries.count < 8 else { continue }
                order += 1
                entries[id] = Entry(action: action, order: order, nextFireAt: now + delay)
            case let .cancel(id): entries[id] = nil
            case .cancelAll: entries = [:]
            }
        }
        schedule()
    }

    func cancelAll() { perform([.cancelAll]) }

    func pause() {
        guard pausedAt == nil else { return }
        pausedAt = now
        handle?.cancel()
        handle = nil
    }

    func resume() {
        guard let pausedAt else { return }
        let elapsed = clock.nowMilliseconds + offset - pausedAt
        for id in entries.keys {
            entries[id]?.nextFireAt += elapsed
        }
        self.pausedAt = nil
        schedule()
    }

    func snapshot() -> [PrototypeTimerSnapshot] {
        sortedEntries().map { id, entry in
            PrototypeTimerSnapshot(id: id, nextFireInMs: max(0, entry.nextFireAt - now), runs: entry.runs)
        }
    }

    /// Advances logical time, processing new timers at their parent's planned time. On the cap,
    /// time stops at the last fire; unprocessed due work is retained for the next call.
    func advance(_ milliseconds: Int) -> AdvanceResult {
        guard pausedAt == nil else { return AdvanceResult(fired: 0, error: nil) }
        return drain(until: now + max(0, milliseconds), advancing: true)
    }

    private func sortedEntries() -> [(key: String, value: Entry)] {
        entries.sorted {
            $0.value.nextFireAt == $1.value.nextFireAt
                ? $0.value.order < $1.value.order : $0.value.nextFireAt < $1.value.nextFireAt
        }
    }

    private func drain(until target: Int, advancing: Bool = false) -> AdvanceResult {
        let initialClockTime = clock.nowMilliseconds
        handle?.cancel()
        handle = nil
        draining = true
        var count = 0
        while let (id, entry) = sortedEntries().first, entry.nextFireAt <= target, count < 10000 {
            firingAt = entry.nextFireAt
            var updated = entry
            updated.runs += 1
            entries[id] = updated
            fire(Array(entry.action.actions ?? []))
            count += 1
            // A command from the fire can replace or cancel this entry. The new generation wins.
            if entries[id]?.order == entry.order {
                if let period = entry.action.everyMs, period >= 100,
                   entry.action.maxRuns.map({ updated.runs < $0 }) ?? true
                {
                    updated.nextFireAt += period
                    entries[id] = updated
                } else {
                    entries[id] = nil
                }
            }
        }
        let capped = count == 10000 && sortedEntries().first.map { $0.value.nextFireAt <= target } == true
        let end = capped ? (firingAt ?? target) : target
        if advancing { offset = end - initialClockTime }
        firingAt = nil
        draining = false
        schedule()
        return AdvanceResult(fired: count, error: capped ? "Timer advance reached 10000-fire limit" : nil)
    }

    private func schedule() {
        guard !draining else { return }
        handle?.cancel()
        handle = nil
        guard pausedAt == nil, let first = sortedEntries().first else { return }
        handle = clock.schedule(afterMilliseconds: max(0, first.value.nextFireAt - now)) { [weak self] in
            guard let self else { return }
            _ = drain(until: now)
        }
    }
}
