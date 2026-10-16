import Foundation

// `swipeActions` on a row or listItem (#12065, `prototype_swipe_actions_v1`). The gesture rules are
// pure so they can be pinned in tests; they mirror `PrototypeSwipe.kt` number for number. Offsets
// are points; a positive offset drags the row right and reveals `start`, a negative one reveals
// `end`. Velocities are points per second.

/// One swipe-revealed button: `label` is its text and accessibility name, `role` `destructive`
/// selects error colours, `color` (hex or theme role) overrides the background.
struct PrototypeSwipeAction: Decodable {
    let label: String
    let icon: String?
    let role: String?
    let color: String?
    let onTap: [PrototypeAction]
}

struct PrototypeSwipeActions: Decodable {
    let start: [PrototypeSwipeAction]?
    let end: [PrototypeSwipeAction]?
    let fullSwipe: Bool?

    /// Test-tag and accessibility-action order: `start` entries first, then `end`.
    var entries: [(side: PrototypeSwipe.Side, action: PrototypeSwipeAction)] {
        (start ?? []).map { (.start, $0) } + (end ?? []).map { (.end, $0) }
    }
}

enum PrototypeSwipe {
    /// Width of one revealed button.
    static let buttonWidth = 80.0
    /// A release past this fraction of the revealed width leaves the row open.
    static let openFraction = 0.4
    /// A fling at least this fast opens or closes regardless of position.
    static let openVelocity = 500.0
    /// With `fullSwipe`, a release past this fraction of the row width runs the first action.
    static let fullFraction = 0.6
    /// With `fullSwipe`, a fling at least this fast past the revealed width runs it.
    static let fullVelocity = 1800.0
    /// Beyond the free range a drag moves this fraction of the finger's travel.
    static let rubberBand = 0.3

    enum Side: Equatable {
        case start, end
    }

    /// The measured row: revealed widths per side (0 when a side has no actions) and the row width.
    struct Geometry: Equatable {
        var startWidth: Double
        var endWidth: Double
        var rowWidth: Double
        var fullSwipe: Bool

        func width(of side: Side) -> Double {
            side == .start ? startWidth : endWidth
        }

        init(actions: PrototypeSwipeActions, rowWidth: Double) {
            startWidth = Double(actions.start?.count ?? 0) * PrototypeSwipe.buttonWidth
            endWidth = Double(actions.end?.count ?? 0) * PrototypeSwipe.buttonWidth
            self.rowWidth = rowWidth
            fullSwipe = actions.fullSwipe == true
        }

        init(startWidth: Double, endWidth: Double, rowWidth: Double, fullSwipe: Bool) {
            self.startWidth = startWidth
            self.endWidth = endWidth
            self.rowWidth = rowWidth
            self.fullSwipe = fullSwipe
        }
    }

    enum Settle: Equatable {
        case closed
        case open(Side)
        /// The first action of the side runs and the row closes.
        case full(Side)
    }

    private static func side(of offset: Double) -> Side {
        offset > 0 ? .start : .end
    }

    /// The offset a finger drag of `raw` points shows: free up to the reveal, then rubber-banded.
    static func rubberBanded(_ raw: Double, _ geometry: Geometry) -> Double {
        if raw == 0 { return 0 }
        let width = geometry.width(of: side(of: raw))
        if width <= 0 { return 0 }
        let free = geometry.fullSwipe ? geometry.rowWidth : width
        let distance = abs(raw)
        let shown = distance <= free ? distance : free + (distance - free) * rubberBand
        return raw > 0 ? shown : -shown
    }

    /// Where a release at `offset` with `velocity` settles.
    static func settle(offset: Double, velocity: Double, _ geometry: Geometry) -> Settle {
        if offset == 0 { return .closed }
        let edge = side(of: offset)
        let width = geometry.width(of: edge)
        if width <= 0 { return .closed }
        let distance = abs(offset)
        // Positive when the finger is still moving the row further open.
        let opening = offset > 0 ? velocity : -velocity
        if geometry.fullSwipe,
           distance >= fullFraction * geometry.rowWidth || (distance > width && opening >= fullVelocity)
        {
            return .full(edge)
        }
        if opening >= openVelocity { return .open(edge) }
        if opening <= -openVelocity { return .closed }
        return distance >= openFraction * width ? .open(edge) : .closed
    }

    /// The resting offset of a settle: closed, exactly the revealed width, or off the row.
    static func restOffset(_ settle: Settle, _ geometry: Geometry) -> Double {
        switch settle {
        case .closed: 0
        case let .open(edge): edge == .start ? geometry.width(of: edge) : -geometry.width(of: edge)
        case let .full(edge): edge == .start ? geometry.rowWidth : -geometry.rowWidth
        }
    }

    /// Widths of the buttons on a side for a revealed `reveal`: the first (edge) one absorbs extra.
    static func buttonWidths(count: Int, reveal: Double) -> [Double] {
        guard count > 0 else { return [] }
        let extra = max(reveal - buttonWidth * Double(count), 0)
        return [buttonWidth + extra] + Array(repeating: buttonWidth, count: count - 1)
    }

    /// A drag is a swipe only when it starts mostly horizontal; otherwise the parent scroll owns it.
    static func isHorizontal(translation: (x: Double, y: Double)) -> Bool {
        abs(translation.x) > abs(translation.y)
    }

    /// Velocity from the last two position samples `(time seconds, x)`; 0 with fewer than two.
    static func velocity(_ samples: [(time: Double, x: Double)]) -> Double {
        guard samples.count >= 2, let last = samples.last else { return 0 }
        let previous = samples[samples.count - 2]
        let elapsed = last.time - previous.time
        return elapsed > 0 ? (last.x - previous.x) / elapsed : 0
    }
}

/// One open row at a time: opening a row reports the row that must close. Rows are identified by
/// their node object, which is distinct per repeated instance.
struct PrototypeSwipeCoordinator: Equatable {
    private(set) var openRow: ObjectIdentifier?
    private(set) var openSide: PrototypeSwipe.Side = .end

    /// Marks `id` open on `side` and returns the previously open row when it is a different one.
    mutating func opened(_ id: ObjectIdentifier, side: PrototypeSwipe.Side = .end) -> ObjectIdentifier? {
        let previous = openRow.flatMap { $0 == id ? nil : $0 }
        openRow = id
        openSide = side
        return previous
    }

    mutating func closed(_ id: ObjectIdentifier) {
        if openRow == id { openRow = nil }
    }

    func isOpen(_ id: ObjectIdentifier) -> Bool {
        openRow == id
    }
}

extension PrototypeSwipe {
    /// On-device checks before typed decoding, with the host's authored paths: a swipe needs a side
    /// and cannot sit inside a horizontal pager or a carousel, whose drag would compete.
    static func validate(_ root: JSONValue) throws {
        try visit(root, path: "root", blocked: false)
    }

    private static func violation(_ path: String, _ message: String) -> DecodingError {
        .dataCorrupted(.init(codingPath: [], debugDescription: "\(path): \(message)"))
    }

    private static func visit(_ value: JSONValue, path: String, blocked: Bool) throws {
        guard case let .object(node) = value else { return }
        if case let .object(swipe)? = node["swipeActions"] {
            if swipe["start"] == nil, swipe["end"] == nil {
                throw violation("\(path).swipeActions", "swipeActions needs start or end")
            }
            if blocked {
                throw violation(
                    "\(path).swipeActions", "swipeActions cannot appear inside a horizontal pager or carousel"
                )
            }
        }
        let horizontal = node["type"] == .string("carousel")
            || (node["type"] == .string("pager") && node["axis"] != .string("vertical"))
        let nested = blocked || horizontal
        if case let .array(children)? = node["children"] {
            for (index, child) in children.enumerated() {
                try visit(child, path: "\(path).children[\(index)]", blocked: nested)
            }
        }
        if let child = node["child"] { try visit(child, path: "\(path).child", blocked: nested) }
        for (screen, screenPath) in PrototypeStacks.screenChildren(in: node, path: path) {
            try visit(screen, path: screenPath, blocked: nested)
        }
    }
}
