import Foundation

/// Queue semantics for a queued media player (#14249): the pure state machine behind `media.next`,
/// `previous`, `skipTo`, `setShuffle`, `setRepeat`, `setRate` and `setSleepTimer`, the twin of
/// Kotlin's `PrototypeQueue`. Both replay `test/fixtures/prototype-media-queue`.
///
/// - The play order is the queue order, or a shuffle that keeps the current item first. Shuffling is
///   a Fisher-Yates pass driven by the injected `PrototypeQueueRandom`, so a fake makes it
///   deterministic.
/// - An explicit `next` ignores repeat `one`; `ended` replays the item under it. Past the last item,
///   repeat `all` wraps and repeat `off` stops on the last item.
/// - `previous` restarts the item when more than `previousRestartMs` in; at the first item it wraps
///   under repeat `all` and otherwise restarts.
/// - A sleep timer counts down on the renderer's clock through `.advance` and pauses at zero;
///   `endOfItem` pauses when the current item ends instead of advancing.
/// - `.sync` replaces the item ids after a data action edits the queue. Removing the current item
///   moves to the next surviving one; with none left it wraps under repeat `all` and otherwise stops
///   on the last item.
enum PrototypeQueue {
    static let previousRestartMs: Int64 = 3000
    static let itemNotFound = "item_not_found"

    enum Repeat: String, Sendable {
        case off
        case one
        case all
    }

    enum Sleep: Equatable, Sendable {
        case timer(remainingMs: Int64)
        case endOfItem
    }

    struct State: Equatable, Sendable {
        /// Item ids in queue (`/data`) order.
        var items: [String]
        /// Item ids in play order: `items`, or a shuffle of them.
        var order: [String]
        var currentItemId: String?
        var playing = false
        var positionMs: Int64 = 0
        var shuffle = false
        var repeatMode: Repeat = .off
        var rate = 1.0
        var sleep: Sleep?

        /// The current item's index in queue order, or -1 with no current item.
        var currentIndex: Int {
            PrototypeQueue.index(of: currentItemId, in: items) ?? -1
        }

        var sleepRemainingMs: Int64? {
            if case let .timer(remainingMs) = sleep { remainingMs } else { nil }
        }
    }

    enum Op: Equatable, Sendable {
        case play
        case pause
        /// The engine reports the playhead.
        case seek(positionMs: Int64)
        case next
        case previous
        case skipTo(itemId: String)
        case setShuffle(Bool)
        case setRepeat(Repeat)
        case setRate(Double)
        /// `ms` 0 cancels; `endOfItem` pauses at the end of the current item.
        case setSleepTimer(ms: Int64, endOfItem: Bool)
        /// The engine reports that the current item played to its end.
        case ended
        /// The renderer's clock advanced.
        case advance(ms: Int64)
        /// A data action replaced the queue's item ids.
        case sync(items: [String])
    }

    /// `itemChanged` means `media.itemChanged` fires; `error` is a stable call error code.
    struct Result: Equatable, Sendable {
        var state: State
        var itemChanged = false
        var error: String?
    }

    static func start(_ items: [String]) -> State {
        let ids = distinct(items)
        return State(items: ids, order: ids, currentItemId: ids.first)
    }

    static func apply(_ state: State, _ op: Op, random: PrototypeQueueRandom) -> Result {
        var next = state
        switch op {
        case .play: next.playing = state.currentItemId != nil
        case .pause: next.playing = false
        case let .seek(positionMs): next.positionMs = positionMs
        case .next: return advanceToNext(state)
        case .previous: return previous(state)
        case let .skipTo(itemId):
            return index(of: itemId, in: state.items) != nil
                ? move(state, to: itemId)
                : Result(state: state, error: itemNotFound)
        case let .setShuffle(shuffle): next = shuffled(state, shuffle, random)
        case let .setRepeat(mode): next.repeatMode = mode
        case let .setRate(rate): next.rate = rate
        case let .setSleepTimer(ms, endOfItem):
            next.sleep = endOfItem ? .endOfItem : ms > 0 ? .timer(remainingMs: ms) : nil
        case .ended: return ended(state)
        case let .advance(ms): next = advanced(state, ms)
        case let .sync(items): return sync(state, distinct(items))
        }
        return Result(state: next)
    }

    // Ids compare by exact UTF-16 code units, as the host, Kotlin and `PrototypeMediaQueue` do: Swift
    // String equality would merge canonically equivalent ids such as "\u{e9}" and "e\u{301}".
    private static func same(_ lhs: String?, _ rhs: String?) -> Bool {
        switch (lhs, rhs) {
        case let (lhs?, rhs?): lhs.utf16.elementsEqual(rhs.utf16)
        case (nil, nil): true
        default: false
        }
    }

    fileprivate static func index(of itemId: String?, in ids: [String]) -> Int? {
        guard let itemId else { return nil }
        return ids.firstIndex { same($0, itemId) }
    }

    private static func distinct(_ items: [String]) -> [String] {
        var seen = Set<[UInt16]>()
        return items.filter { seen.insert(Array($0.utf16)).inserted }
    }

    private static func move(_ state: State, to itemId: String?, playing: Bool? = nil) -> Result {
        var next = state
        next.currentItemId = itemId
        next.positionMs = 0
        next.playing = (playing ?? state.playing) && itemId != nil
        return Result(state: next, itemChanged: !same(itemId, state.currentItemId))
    }

    /// The item after the current one in play order, wrapping under repeat `all`.
    private static func following(_ state: State) -> String? {
        let position = index(of: state.currentItemId, in: state.order) ?? -1
        if position + 1 < state.order.count {
            return state.order[position + 1]
        }
        return state.repeatMode == .all ? state.order.first : nil
    }

    private static func stopped(_ state: State) -> Result {
        var next = state
        next.playing = false
        return Result(state: next)
    }

    private static func advanceToNext(_ state: State) -> Result {
        guard state.currentItemId != nil else { return Result(state: state) }
        guard let target = following(state) else { return stopped(state) }
        return move(state, to: target)
    }

    private static func previous(_ state: State) -> Result {
        guard let current = state.currentItemId,
              let position = index(of: current, in: state.order) else { return Result(state: state) }
        if state.positionMs > previousRestartMs {
            var next = state
            next.positionMs = 0
            return Result(state: next)
        }
        let target = position > 0
            ? state.order[position - 1]
            : state.repeatMode == .all ? state.order.last ?? current : current
        return move(state, to: target)
    }

    private static func ended(_ state: State) -> Result {
        guard state.currentItemId != nil else { return Result(state: state) }
        var next = state
        if state.sleep == .endOfItem {
            next.playing = false
            next.sleep = nil
            return Result(state: next)
        }
        if state.repeatMode == .one {
            next.positionMs = 0
            return Result(state: next)
        }
        guard let target = following(state) else { return stopped(state) }
        return move(state, to: target)
    }

    private static func advanced(_ state: State, _ ms: Int64) -> State {
        guard let remainingMs = state.sleepRemainingMs else { return state }
        var next = state
        let remaining = remainingMs - ms
        if remaining > 0 {
            next.sleep = .timer(remainingMs: remaining)
        } else {
            next.sleep = nil
            next.playing = false
        }
        return next
    }

    private static func shuffled(_ state: State, _ shuffle: Bool, _ random: PrototypeQueueRandom) -> State {
        guard shuffle != state.shuffle else { return state }
        var next = state
        next.shuffle = shuffle
        guard shuffle else {
            next.order = state.items
            return next
        }
        var rest = state.items.filter { !same($0, state.currentItemId) }
        if rest.count > 1 {
            for index in stride(from: rest.count - 1, through: 1, by: -1) {
                rest.swapAt(index, random.nextInt(index + 1))
            }
        }
        next.order = (state.currentItemId.map { [$0] } ?? []) + rest
        return next
    }

    private static func sync(_ state: State, _ items: [String]) -> Result {
        let keptKeys = Set(items.map { Array($0.utf16) })
        let kept = { (id: String) in keptKeys.contains(Array(id.utf16)) }
        let added = { (id: String) in index(of: id, in: state.order) == nil }
        var synced = state
        synced.items = items
        synced.order = state.shuffle ? state.order.filter(kept) + items.filter(added) : items
        guard let current = state.currentItemId else { return move(synced, to: items.first) }
        if kept(current) {
            return Result(state: synced)
        }
        let position = index(of: current, in: state.order) ?? -1
        let target = state.order.dropFirst(position + 1).first(where: kept) ?? items.first(where: added)
        if let target {
            return move(synced, to: target)
        }
        if state.repeatMode == .all {
            return move(synced, to: synced.order.first)
        }
        return move(synced, to: synced.order.last, playing: false)
    }
}

/// Randomness for shuffling: an integer in `0 ..< bound`.
protocol PrototypeQueueRandom {
    func nextInt(_ bound: Int) -> Int
}
