import Foundation

struct PrototypePagerPeek: Decodable, Equatable {
    let start: Double?
    let end: Double?
}

enum PrototypePagerPageSize: Decodable, Equatable {
    case fill
    case fixed(Double)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self), value == "fill" {
            self = .fill
        } else {
            let fields = try container.decode([String: Double].self)
            guard fields.count == 1, let points = fields["dp"] else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Expected exactly dp")
            }
            self = .fixed(points)
        }
    }
}

/// On-device validation before typed decoding, preserving the host's authored tree paths.
enum PrototypePagerOptions {
    /// Pending contract-wide maxima from #12298.
    static let maxPagerDp = 10000.0

    static func validate(_ root: JSONValue) throws {
        try visit(root, path: "root", verticalScrollAncestor: false)
    }

    private static func violation(_ path: String, _ message: String) -> DecodingError {
        .dataCorrupted(.init(codingPath: [], debugDescription: "\(path): \(message)"))
    }

    private static func distance(_ value: JSONValue, path: String, minimum: Double = 0) throws {
        guard case let .number(number) = value, number.isFinite,
              (minimum ... maxPagerDp).contains(number)
        else { throw violation(path, "Invalid number value") }
    }

    private static func validatePeek(_ value: JSONValue, path: String) throws {
        guard case let .object(fields) = value else { throw violation(path, "Expected object") }
        for key in fields.keys.sorted() where key != "start" && key != "end" {
            throw violation("\(path).\(key)", "Unknown property")
        }
        for key in ["start", "end"] {
            if let value = fields[key] { try distance(value, path: "\(path).\(key)") }
        }
    }

    private static func validatePageSize(_ value: JSONValue, path: String) throws {
        if value == .string("fill") { return }
        if case .string = value { throw violation(path, "Invalid enum value") }
        guard case let .object(fields) = value else { throw violation(path, "Expected object") }
        for key in fields.keys.sorted() where key != "dp" {
            throw violation("\(path).\(key)", "Unknown property")
        }
        guard let points = fields["dp"] else { throw violation("\(path).dp", "Required") }
        try distance(points, path: "\(path).dp", minimum: 1e-6)
    }

    private static func visit(_ value: JSONValue, path: String, verticalScrollAncestor: Bool) throws {
        guard case let .object(node) = value else { return }
        if node["type"] == .string("pager") {
            if let axis = node["axis"], axis != .string("horizontal"), axis != .string("vertical") {
                throw violation("\(path).axis", "Invalid enum value")
            }
            if let spacing = node["pageSpacing"] { try distance(spacing, path: "\(path).pageSpacing") }
            if let peek = node["peek"] { try validatePeek(peek, path: "\(path).peek") }
            if let size = node["pageSize"] { try validatePageSize(size, path: "\(path).pageSize") }
            if verticalScrollAncestor, node["axis"] == .string("vertical") {
                throw violation("\(path).axis", "A vertical pager cannot appear inside a vertical scroll")
            }
        }
        let insideVerticalScroll = verticalScrollAncestor ||
            (node["type"] == .string("scroll") && node["axis"] != .string("horizontal"))
        if case let .array(children)? = node["children"] {
            for (index, child) in children.enumerated() {
                try visit(child, path: "\(path).children[\(index)]", verticalScrollAncestor: insideVerticalScroll)
            }
        }
        if let child = node["child"] {
            try visit(child, path: "\(path).child", verticalScrollAncestor: insideVerticalScroll)
        }
        for (screen, screenPath) in PrototypeStacks.screenChildren(in: node, path: path) {
            try visit(screen, path: screenPath, verticalScrollAncestor: insideVerticalScroll)
        }
    }
}

/// Pure renderer decisions, kept in the core so SwiftPM can pin the legacy route and defaults.
struct PrototypePagerLayout: Equatable {
    let legacy: Bool
    let vertical: Bool
    let spacing: Double
    let start: Double
    let end: Double
    let pageSize: PrototypePagerPageSize

    /// At rest the selected page aligns to the leading margin, bounded by the content end.
    /// Strict intersection excludes pages whose edge merely touches the viewport.
    func visiblePages(selected: Int, count: Int, viewportExtent: Double) -> [Int] {
        // `count` is the page count parameter, not a collection.
        // swiftlint:disable:next empty_count
        guard count > 0, viewportExtent.isFinite, viewportExtent > 0 else { return [] }
        let extent: Double
        switch pageSize {
        case .fill: extent = max(0, viewportExtent - start - end)
        case let .fixed(points): extent = points
        }
        guard extent > 0 else { return [] }
        let contentExtent = start + Double(count) * extent + Double(count - 1) * spacing + end
        let leadingOffset = min(Double(selected) * (extent + spacing), max(0, contentExtent - viewportExtent))
        return (0 ..< count).filter { index in
            let origin = start + Double(index) * (extent + spacing) - leadingOffset
            return origin < viewportExtent && origin + extent > 0
        }
    }

    init(node: PrototypeNode) {
        vertical = node.axis == "vertical"
        spacing = node.pageSpacing ?? 0
        start = node.peek?.start ?? 0
        end = node.peek?.end ?? 0
        pageSize = node.pageSize ?? .fill
        legacy = (node.axis == nil || node.axis == "horizontal") &&
            spacing == 0 && start == 0 && end == 0 && pageSize == .fill
    }
}
