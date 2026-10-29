import Foundation

/// Which feed players hold a decoder (#14258): the pure allocation behind `autoplay: "whenVisible"`,
/// the twin of Kotlin's `PrototypeMediaPool`. Both replay `test/fixtures/prototype-media-pool`.
///
/// The anchor is the settled pager page, or else the most visible player (ties go to the topmost).
/// The window is the anchor, the next item and the previous item, at most `maxActiveDecoders`. The
/// anchor plays only in the foreground, and only when its page has settled (pager) or it is at least
/// `visibleThreshold` visible (list). Window players that do not play are preloaded; held players
/// outside the window are released.
enum PrototypeMediaPool {
    static let maxActiveDecoders = PrototypeContractValidator.limit("MAX_PROTOTYPE_ACTIVE_DECODERS")
    /// The visible fraction a list player needs to play when its node omits `visibleThreshold`.
    static let defaultVisibleThreshold = 0.6

    enum Mode: String, Sendable {
        case pager
        case list
    }

    /// One feed player, in layout order: page order for a pager, top to bottom for a list.
    struct Item: Equatable, Sendable {
        let id: String
        let visibleFraction: Double
    }

    struct Input: Equatable, Sendable {
        let mode: Mode
        let items: [Item]
        /// The settled page; `nil` while a pager is mid-swipe. Ignored for lists.
        let settledIndex: Int?
        let visibleThreshold: Double
        let foreground: Bool
        /// The players that hold a decoder now.
        let held: [String]

        init(
            mode: Mode, items: [Item], settledIndex: Int? = nil,
            visibleThreshold: Double = PrototypeMediaPool.defaultVisibleThreshold,
            foreground: Bool = true, held: [String] = []
        ) {
            self.mode = mode
            self.items = items
            self.settledIndex = settledIndex
            self.visibleThreshold = visibleThreshold
            self.foreground = foreground
            self.held = held
        }
    }

    struct Allocation: Equatable, Sendable {
        let play: String?
        let preload: [String]
        let release: [String]
    }

    static func allocate(_ input: Input) -> Allocation {
        let items = input.items
        let settled = input.settledIndex.flatMap { index in
            input.mode == .pager && items.indices.contains(index) ? index : nil
        }
        let anchor = settled ?? mostVisible(items)
        let window = anchor.map { anchor in
            [anchor, anchor + 1, anchor - 1].filter(items.indices.contains)
                .prefix(maxActiveDecoders).map { items[$0].id }
        } ?? []
        let playable = switch input.mode {
        case .pager: settled != nil
        case .list: anchor.map { items[$0].visibleFraction >= input.visibleThreshold } ?? false
        }
        let play = input.foreground && playable ? anchor.map { items[$0].id } : nil
        var released: [String] = []
        for id in input.held where !window.contains(id) && !released.contains(id) {
            released.append(id)
        }
        return Allocation(play: play, preload: window.filter { $0 != play }, release: released)
    }

    /// The index of the most visible item, the topmost on a tie; `nil` when nothing is visible.
    private static func mostVisible(_ items: [Item]) -> Int? {
        var best: Int?
        for index in items.indices where items[index].visibleFraction > 0 {
            if best.map({ items[index].visibleFraction > items[$0].visibleFraction }) ?? true {
                best = index
            }
        }
        return best
    }
}
