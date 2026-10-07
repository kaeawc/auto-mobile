import Foundation

/// Arbitrary JSON, used for state values and emit payloads.
enum JSONValue: Codable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = try .object(container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }

    var displayString: String {
        switch self {
        case let .string(value): return value
        case let .bool(value): return String(value)
        case let .number(value):
            return value.rounded() == value && abs(value) < 1e15 ? String(Int64(value)) : String(value)
        default: return ""
        }
    }

    var intValue: Int? {
        if case let .number(value) = self { return Int(value) }
        return nil
    }

    var boolValue: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }
}

struct OverlaySpec: Decodable {
    let id: String
    let window: WindowSpec
    let state: [String: JSONValue]?
    let root: OverlayNode
}

struct WindowSpec: Decodable {
    let placement: Placement
    let opacity: Int?
}

struct Placement: Decodable {
    let type: String
    let scrim: String?
    let edge: String?
    let height: Double?
    let gravity: String?
    let offset: Offset?
}

struct Offset: Decodable {
    let x: Double
    let y: Double
}

enum Dimension: Decodable {
    case fill
    case wrap
    case points(Double)

    private struct Fixed: Decodable { let dp: Double }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let keyword = try? container.decode(String.self) {
            self = keyword == "fill" ? .fill : .wrap
        } else {
            self = try .points(container.decode(Fixed.self).dp)
        }
    }
}

struct Padding: Decodable {
    let top: Double?
    let bottom: Double?
    let start: Double?
    let end: Double?
}

struct Border: Decodable {
    let width: Double
    let color: String
}

struct Style: Decodable {
    let width: Dimension?
    let height: Dimension?
    let padding: Padding?
    let background: String?
    let cornerRadius: Double?
    let border: Border?
    let alpha: Double?
    let alignment: String?
    let arrangement: String?
    let spacing: Double?
    let textSize: Double?
    let fontWeight: Int?
    let color: String?
    let textAlign: String?
    let maxLines: Int?
    let fontFamily: String?
}

struct OverlayAction: Decodable {
    let type: String
    let name: String?
    let payload: JSONValue?
    let pager: String?
    let page: JSONValue?
    let key: String?
    let value: JSONValue?
}

struct Condition: Decodable {
    let key: String
    let equals: JSONValue
}

struct SafeAreaPadding: Decodable {
    let edges: [String]
    let types: [String]
}

struct NavItem: Decodable {
    let label: String
    let icon: String?
    let image: String?
}

/// One spec node. A class so `child` can recurse; the renderer reads only the fields its type uses.
final class OverlayNode: Decodable {
    let type: String
    let id: String?
    let testTag: String?
    let onTap: [OverlayAction]?
    let style: Style?
    let visibleWhen: Condition?
    let safeAreaPadding: SafeAreaPadding?
    let children: [OverlayNode]?
    let child: OverlayNode?
    let text: String?
    let asset: String?
    let contentScale: String?
    let name: String?
    let stateKey: String?
    let placeholder: String?
    let axis: String?
    let items: [NavItem]?
    let pager: String?
    let scrollable: Bool?
    let openWhen: Condition?
    let scrim: String?
    let dragHandle: Bool?

    /// Pager ids and their page counts, so `setPage` can clamp without consulting the view tree.
    func collectPagers(into counts: inout [String: Int]) {
        if type == "pager", let id {
            counts[id] = children?.count ?? 0
        }
        children?.forEach { $0.collectPagers(into: &counts) }
        child?.collectPagers(into: &counts)
    }

    /// Asset ids the spec references, for the `missingAssets` warning.
    func collectAssets(into ids: inout Set<String>) {
        if let asset { ids.insert(asset) }
        items?.compactMap(\.image).forEach { ids.insert($0) }
        children?.forEach { $0.collectAssets(into: &ids) }
        child?.collectAssets(into: &ids)
    }
}
