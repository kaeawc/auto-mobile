// Generated from schemas/prototype-spec-contract.json; do not edit.
// Regenerate: bun scripts/prototype/generate-prototype-spec-models.ts

struct PrototypePress: Decodable, Equatable, Sendable {
    let scale: Double?
    let alpha: Double?
}

struct ShadowOffset: Codable, Equatable, Sendable {
    let x: Double
    let y: Double
}

struct Shadow: Decodable, Equatable, Sendable {
    let color: PrototypeModeValue
    let radius: Double
    let spread: Double?
    let offset: ShadowOffset?
    let inner: Bool?
}

struct FadeEdges: Codable, Equatable, Sendable {
    let top: Double?
    let bottom: Double?
    let start: Double?
    let end: Double?
}

struct ImageFilter: Decodable, Equatable, Sendable {
    let saturation: Double?
    let tint: PrototypeModeValue?
}

/// Tooltip spotlight hole: padding 0..64 dp (default 8), cornerRadius 0..64 dp (default 12).
struct TooltipSpotlight: Codable, Equatable, Sendable {
    let padding: Int?
    let cornerRadius: Int?
}

struct ScrollEdge: Codable, Equatable, Sendable {
    let scale: Double?
    let alpha: Double?
    let rotation: Double?
}

struct ScrollTransition: Codable, Equatable, Sendable {
    let axis: String
    let edge: ScrollEdge
}

struct ScrollLinked: Codable, Equatable, Sendable {
    let source: String
    let range: [Double]
    let alpha: [Double]?
    let scale: [Double]?
    let offsetY: [Double]?
    let offsetX: [Double]?
    let blur: [Double]?
}

struct IosNamespaceTab: Codable, Equatable, Sendable {
    let role: String
}

struct IosNamespaceSheet: Codable, Equatable, Sendable {
    let sizing: String
}

struct IosNamespace: Codable, Equatable, Sendable {
    let buttonStyle: String?
    let tab: IosNamespaceTab?
    let sheet: IosNamespaceSheet?
    let hover: String?
    let navigationTitle: String?
}

struct AndroidNamespacePredictiveBack: Codable, Equatable, Sendable {
    let style: String
}

struct AndroidNamespace: Codable, Equatable, Sendable {
    let predictiveBack: AndroidNamespacePredictiveBack?
    let indication: String?
}

struct Offset: Codable, Equatable, Sendable {
    let x: Double
    let y: Double
}

struct Padding: Codable, Equatable, Sendable {
    let top: Double?
    let bottom: Double?
    let start: Double?
    let end: Double?
}

struct SafeAreaPadding: Codable, Equatable, Sendable {
    let edges: [String]
    let types: [String]
}

/// A fixed y axis for a chart; `max` is above `min`.
struct PrototypeChartRange: Codable, Equatable, Sendable {
    let min: Double
    let max: Double
}

struct PrototypeShader: Codable, Equatable, Sendable {
    let asset: String
    let uniforms: [String: Double]?
}

/// An icon-only control in a `topAppBar`: the icon, its accessible label and its tap.
struct PrototypeAppBarAction: Decodable {
    let icon: String
    let label: String
    let onTap: [PrototypeAction]?
}

/// A `dialog` or `snackbar` button: a tap closes its container, then runs `onTap`.
struct PrototypeDialogButton: Decodable {
    let label: String
    let onTap: [PrototypeAction]?
}

enum Placement: Decodable {
    case fullscreen(scrim: PrototypeModeValue?)
    case sheet(edge: String, height: Double)
    case floating(gravity: String, offset: Offset)

    private enum CodingKeys: String, CodingKey {
        case type
        case scrim
        case edge
        case height
        case gravity
        case offset
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "fullscreen":
            self = try .fullscreen(
                scrim: container.decodeIfPresent(PrototypeModeValue.self, forKey: .scrim)
            )
        case "sheet":
            self = try .sheet(
                edge: container.decode(String.self, forKey: .edge),
                height: container.decode(Double.self, forKey: .height)
            )
        case "floating":
            self = try .floating(
                gravity: container.decode(String.self, forKey: .gravity),
                offset: container.decode(Offset.self, forKey: .offset)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown Placement type \(type)"
            )
        }
    }
}

enum PrototypeGradient: Decodable, Equatable {
    case linear(angle: Double, stops: [PrototypeGradientStop])
    case radial(stops: [PrototypeGradientStop])

    private enum CodingKeys: String, CodingKey {
        case type
        case angle
        case stops
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "linear":
            let angle = try container.decode(Double.self, forKey: .angle)
            let stops = try container.decode([PrototypeGradientStop].self, forKey: .stops)
            try PrototypeGradient.validateStops(stops, forKey: .stops, in: container)
            self = .linear(
                angle: angle,
                stops: stops
            )
        case "radial":
            let stops = try container.decode([PrototypeGradientStop].self, forKey: .stops)
            try PrototypeGradient.validateStops(stops, forKey: .stops, in: container)
            self = .radial(
                stops: stops
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown PrototypeGradient type \(type)"
            )
        }
    }
}

/// The control at the end of a `listItem`: a bound switch or checkbox, or a decorative icon.
enum PrototypeListItemTrailing: Codable, Equatable, Sendable {
    case `switch`(stateKey: String)
    case checkbox(stateKey: String)
    case icon(name: String)

    private enum CodingKeys: String, CodingKey {
        case type
        case stateKey
        case name
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "switch":
            self = try .switch(
                stateKey: container.decode(String.self, forKey: .stateKey)
            )
        case "checkbox":
            self = try .checkbox(
                stateKey: container.decode(String.self, forKey: .stateKey)
            )
        case "icon":
            self = try .icon(
                name: container.decode(String.self, forKey: .name)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown PrototypeListItemTrailing type \(type)"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .switch(stateKey: stateKey):
            try container.encode("switch", forKey: .type)
            try container.encode(stateKey, forKey: .stateKey)
        case let .checkbox(stateKey: stateKey):
            try container.encode("checkbox", forKey: .type)
            try container.encode(stateKey, forKey: .stateKey)
        case let .icon(name: name):
            try container.encode("icon", forKey: .type)
            try container.encode(name, forKey: .name)
        }
    }
}

/// One gradient stop: a colour slot and an optional position in 0...1.
struct PrototypeGradientStop: Decodable, Equatable {
    let color: PrototypeModeValue
    let position: Double?
}

struct Border: Decodable {
    let width: Double
    let color: PrototypeModeValue?
    let gradient: PrototypeGradient?
}

struct NavItem: Decodable {
    let label: String
    let icon: String?
    /// An uploaded image asset id, or a `{light, dark}` pair of ids (#11218).
    let image: PrototypeModeValue?
}
