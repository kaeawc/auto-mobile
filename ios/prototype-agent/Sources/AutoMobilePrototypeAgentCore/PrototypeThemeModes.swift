import Foundation

// The spec forms behind `prototype_theme_modes_v1` (#11218, #11220): gradients whose stops take a
// role or a `{light, dark}` pair, and the on-device check of every per-mode value. Resolution
// itself is `PrototypeModeValue.value(dark:)` and `PrototypePalette.resolve`.

/// One gradient stop: a colour slot and an optional position in 0...1.
struct PrototypeGradientStop: Decodable, Equatable {
    let color: PrototypeModeValue
    let position: Double?
}

/// A resolved gradient stop: the colour for the palette's mode and its location in 0...1.
struct PrototypeGradientColorStop: Equatable {
    let color: PrototypeRGBA
    let location: Double
}

/// A point in a node's unit square: (0, 0) is its top left corner, (1, 1) its bottom right.
struct PrototypeUnitPoint: Equatable {
    let x: Double
    let y: Double
}

/// `style.gradient`: linear along an angle, or radial from the node's centre.
enum PrototypeGradient: Decodable, Equatable {
    case linear(angle: Double, stops: [PrototypeGradientStop])
    case radial(stops: [PrototypeGradientStop])

    /// The contract's stop count.
    static let stopCount = 2 ... 4

    private enum CodingKeys: String, CodingKey {
        case type, angle, stops
    }

    /// The shared validator's rules, since iOS has no other check: a known type, an angle on a
    /// linear gradient, two to four stops, and positions inside 0...1.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let stops = try container.decode([PrototypeGradientStop].self, forKey: .stops)
        guard Self.stopCount.contains(stops.count) else {
            throw DecodingError.dataCorruptedError(
                forKey: .stops, in: container, debugDescription: "A gradient needs 2 to 4 stops"
            )
        }
        guard stops.allSatisfy({ stop in stop.position.map { (0 ... 1).contains($0) } ?? true }) else {
            throw DecodingError.dataCorruptedError(
                forKey: .stops, in: container, debugDescription: "A gradient stop position must be within 0 and 1"
            )
        }
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "linear": self = try .linear(angle: container.decode(Double.self, forKey: .angle), stops: stops)
        case "radial": self = .radial(stops: stops)
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container, debugDescription: "Unknown gradient type \(type)"
            )
        }
    }

    var stops: [PrototypeGradientStop] {
        switch self {
        case let .linear(_, stops), let .radial(stops): stops
        }
    }

    /// The stops as drawn, as Android's `prototypeGradientStops`: each colour resolved for the
    /// palette's mode (a value that resolves to nothing is transparent), and the authored positions
    /// only when every stop has one, made non-decreasing so a stop never starts before the previous
    /// one. Otherwise the stops are spread evenly.
    func colorStops(palette: PrototypePalette) -> [PrototypeGradientColorStop] {
        let stops = stops
        let clear = PrototypeRGBA(red: 0, green: 0, blue: 0, alpha: 0)
        let authored = stops.compactMap(\.position)
        var floor = 0.0
        return stops.enumerated().map { index, stop in
            let location: Double
            if authored.count == stops.count {
                floor = max(floor, authored[index])
                location = floor
            } else {
                location = stops.count > 1 ? Double(index) / Double(stops.count - 1) : 0
            }
            return PrototypeGradientColorStop(color: palette.resolve(stop.color) ?? clear, location: location)
        }
    }

    /// The linear gradient line for a `width` x `height` box, as Android's
    /// `prototypeLinearGradientLine`, in unit coordinates. The angle is degrees clockwise from left
    /// to right: 0 runs left to right, 90 top to bottom. The line passes through the centre and is
    /// long enough that the corners take the first and last stop colours, so its ends can lie
    /// outside the box.
    static func linearLine(angle: Double, width: Double, height: Double) -> (
        start: PrototypeUnitPoint, end: PrototypeUnitPoint
    ) {
        let radians = angle * .pi / 180
        let dx = cos(radians)
        let dy = sin(radians)
        let half = (abs(width * dx) + abs(height * dy)) / 2
        // An empty box draws nothing; keep the line finite.
        let x = width > 0 ? dx * half / width : 0
        let y = height > 0 ? dy * half / height : 0
        return (PrototypeUnitPoint(x: 0.5 - x, y: 0.5 - y), PrototypeUnitPoint(x: 0.5 + x, y: 0.5 + y))
    }

    /// The radial gradient's radius in points: centre to corner, so the last stop lands on the
    /// corners (Android's `hypot(width, height) / 2`).
    static func radialRadius(width: Double, height: Double) -> Double {
        (width * width + height * height).squareRoot() / 2
    }
}

/// What a `tabBar` or `bottomNav` item draws above its label.
enum PrototypeNavVisual: Equatable {
    /// The uploaded image with this asset id.
    case image(String)
    /// The built-in icon with this name.
    case icon(String)
    /// An image was named but is not uploaded, and there is no icon to fall back to.
    case placeholder
    case none
}

extension NavItem {
    /// As Android's `prototypeNavigationVisual`: the image for the resolved mode when it is
    /// uploaded, then the built-in icon, then a placeholder square.
    func visual(dark: Bool, available: Set<String>) -> PrototypeNavVisual {
        let id = image?.value(dark: dark)
        if let id, available.contains(id) { return .image(id) }
        if let icon { return .icon(icon) }
        return id == nil ? .none : .placeholder
    }
}

/// The on-device check for the forms `prototype_theme_modes_v1` added. The agent has no copy of
/// the host validator, and before this capability the host refused these forms outright, so a
/// malformed one could only arrive from a host that skipped validation. It must not draw as
/// something else: `PrototypeSpec` decoding throws, and the agent answers `show_prototype` with
/// `Invalid prototype spec`, leaving whatever was shown untouched.
///
/// Checked here: both sides of every colour pair, every gradient stop colour, every scrim (a
/// scrim took only a hex value before), and both ids of an image pair. The pair's shape is checked
/// by `PrototypeModeValue`, the gradient's by `PrototypeGradient`, and the `theme.colors` mode maps
/// by `PrototypeThemeColors`. A single value in a slot that predates the capability (a style
/// colour, a border or shadow colour, an image id) keeps its older behaviour: an unknown value
/// draws that slot's fallback.
enum PrototypeThemeModes {
    static func validate(placement: Placement, root: PrototypeNode) throws {
        try color(placement.scrim, "window.placement.scrim", checksSingle: true)
        try visit(root, path: "root")
    }

    /// A hex literal or a Material role name.
    static func isColor(_ value: String) -> Bool {
        value.hasPrefix("#") ? PrototypeRGBA(hex: value) != nil : PrototypePalette.roleNames.contains(value)
    }

    static func violation(_ path: String, _ message: String) -> DecodingError {
        .dataCorrupted(.init(codingPath: [], debugDescription: "\(path): \(message)"))
    }

    private static func visit(_ node: PrototypeNode, path: String) throws {
        try style(node.style, "\(path).style")
        for (index, entry) in (node.styleWhen ?? []).enumerated() {
            try style(entry.style, "\(path).styleWhen[\(index)].style")
        }
        try color(node.scrim, "\(path).scrim", checksSingle: true)
        try asset(node.asset, "\(path).asset")
        for (index, item) in (node.items ?? []).enumerated() {
            try asset(item.image, "\(path).items[\(index)].image")
        }
        for (index, child) in (node.children ?? []).enumerated() {
            try visit(child, path: "\(path).children[\(index)]")
        }
        if let child = node.child {
            try visit(child, path: "\(path).child")
        }
    }

    private static func style(_ style: Style?, _ path: String) throws {
        guard let style else { return }
        try color(style.background, "\(path).background", checksSingle: false)
        try color(style.color, "\(path).color", checksSingle: false)
        try color(style.shadowColor, "\(path).shadowColor", checksSingle: false)
        try color(style.border?.color, "\(path).border.color", checksSingle: false)
        for (index, stop) in (style.gradient?.stops ?? []).enumerated() {
            try color(stop.color, "\(path).gradient.stops[\(index)].color", checksSingle: true)
        }
    }

    private static func color(_ value: PrototypeModeValue?, _ path: String, checksSingle: Bool) throws {
        let message = "Expected #RRGGBB, #AARRGGBB or a colour role"
        switch value {
        case nil:
            return
        case let .single(single):
            if checksSingle, !isColor(single) { throw violation(path, message) }
        case let .modes(light, dark):
            if !isColor(light) { throw violation("\(path).light", message) }
            if !isColor(dark) { throw violation("\(path).dark", message) }
        }
    }

    private static func asset(_ value: PrototypeModeValue?, _ path: String) throws {
        guard case let .modes(light, dark)? = value else { return }
        if light.isEmpty { throw violation("\(path).light", "Expected a non-empty asset id") }
        if dark.isEmpty { throw violation("\(path).dark", "Expected a non-empty asset id") }
    }
}
