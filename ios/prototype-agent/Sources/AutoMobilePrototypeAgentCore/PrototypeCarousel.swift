import Foundation

/// Pure decisions for the `carousel` node and the pager `indicator` (#12071, `prototype_carousel_v1`).
enum PrototypeCarousel {
    /// iOS draws every variant as fixed-width snapping items: `itemWidth`, never below one point.
    static func itemWidth(_ node: PrototypeNode) -> Double {
        max(node.itemWidth ?? 1, 1)
    }

    static func spacing(_ node: PrototypeNode) -> Double {
        max(node.itemSpacing ?? 0, 0)
    }

    /// One flag per page: true for the page drawn as the filled dot. The selection is clamped, so a
    /// transient out-of-range value still fills exactly one dot.
    static func indicatorDots(count: Int, selected: Int) -> [Bool] {
        // `count` is the page count parameter, not a collection.
        guard count >= 1 else { return [] }
        let current = min(max(selected, 0), count - 1)
        return (0 ..< count).map { $0 == current }
    }

    static func showsIndicator(_ node: PrototypeNode) -> Bool {
        node.type == "pager" && node.indicator == "dots"
    }

    /// Where a pager's dots sit relative to its pages: a row under a horizontal pager, a column
    /// beside a vertical one. They are laid out after the pages, never drawn over them.
    enum IndicatorSide: Equatable {
        case below
        case beside
    }

    static func indicatorSide(vertical: Bool) -> IndicatorSide {
        vertical ? .beside : .below
    }
}

extension PrototypeCarousel {
    static let maxDp = 10000.0

    /// On-device checks before typed decoding, with the host's authored paths. Children are not
    /// counted here: a repeat template may legitimately expand to no items.
    static func validate(_ root: JSONValue) throws {
        try visit(root, path: "root")
    }

    private static func violation(_ path: String, _ message: String) -> DecodingError {
        .dataCorrupted(.init(codingPath: [], debugDescription: "\(path): \(message)"))
    }

    private static func validateCarousel(_ node: [String: JSONValue], path: String) throws {
        if let variant = node["variant"] {
            let known = ["multiBrowse", "hero", "uncontained"].map(JSONValue.string)
            guard known.contains(variant) else { throw violation("\(path).variant", "Invalid enum value") }
        }
        guard case let .number(width)? = node["itemWidth"] else {
            throw violation("\(path).itemWidth", "Required")
        }
        guard width.isFinite, width > 0, width <= maxDp else {
            throw violation("\(path).itemWidth", "Invalid number value")
        }
        if let spacing = node["itemSpacing"] {
            guard case let .number(gap) = spacing, gap.isFinite, gap >= 0, gap <= maxDp else {
                throw violation("\(path).itemSpacing", "Invalid number value")
            }
        }
    }

    private static func visit(_ value: JSONValue, path: String) throws {
        guard case let .object(node) = value else { return }
        if node["type"] == .string("pager"), let indicator = node["indicator"],
           indicator != .string("none"), indicator != .string("dots")
        {
            throw violation("\(path).indicator", "Invalid enum value")
        }
        if node["type"] == .string("carousel") {
            try validateCarousel(node, path: path)
        }
        if case let .array(children)? = node["children"] {
            for (index, child) in children.enumerated() {
                try visit(child, path: "\(path).children[\(index)]")
            }
        }
        if let child = node["child"] { try visit(child, path: "\(path).child") }
        for (screen, screenPath) in PrototypeStacks.screenChildren(in: node, path: path) {
            try visit(screen, path: screenPath)
        }
    }
}
