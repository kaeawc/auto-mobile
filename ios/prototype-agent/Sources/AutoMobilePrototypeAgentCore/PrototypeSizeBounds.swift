import Foundation

/// Numeric layout bounds mirrored from the shared contract. This walks authored nodes (including
/// inactive styles and repeat templates) before decoding or resolving them. Opaque data/state and
/// action payloads are deliberately outside this check. Tests pin every range to the contract.
enum PrototypeSizeBounds {
    static let maxLength = 10000.0
    static let maxTypography = 1000.0
    static let maxElevation = 1000.0
    static let maxDurationMs = 2000.0
    static let maxTransitionDelayMs = 600.0
    static let maxStaggerMs = 100.0
    static let maxZoomScale = 8.0
    static let maxStyleScale = 4.0
    static let maxRotation = 360.0
    static let minPositive = 0.000001

    static let ranges: [String: [String: ClosedRange<Double>]] = [
        "dimension": ["dp": 0 ... maxLength],
        "detent": ["dp": minPositive ... maxLength],
        "bounds": ["x": -maxLength ... maxLength, "y": -maxLength ... maxLength,
                   "width": 0 ... maxLength, "height": 0 ... maxLength],
        "offset": ["x": -maxLength ... maxLength, "y": -maxLength ... maxLength],
        "padding": ["top": 0 ... maxLength, "bottom": 0 ... maxLength,
                    "start": 0 ... maxLength, "end": 0 ... maxLength],
        "cornerRadius": ["topStart": 0 ... maxLength, "topEnd": 0 ... maxLength,
                         "bottomStart": 0 ... maxLength, "bottomEnd": 0 ... maxLength],
        "border": ["width": 0 ... maxLength],
        "animate": ["durationMs": 0 ... maxDurationMs],
        "transition": ["delayMs": 0 ... maxTransitionDelayMs],
        "stagger": ["ms": 0 ... maxStaggerMs],
        "zoomable": ["maxScale": 1 ... maxZoomScale],
        "sheet": ["height": minPositive ... maxLength],
        "textSpanStyle": ["textSize": minPositive ... maxTypography,
                          "letterSpacing": -maxTypography ... maxTypography],
        "style": [
            "weight": minPositive ... maxLength, "aspectRatio": minPositive ... maxLength,
            "minWidth": 0 ... maxLength, "maxWidth": 0 ... maxLength,
            "minHeight": 0 ... maxLength, "maxHeight": 0 ... maxLength,
            "cornerRadius": 0 ... maxLength, "spacing": 0 ... maxLength,
            "runSpacing": 0 ... maxLength,
            "scale": 0 ... maxStyleScale, "rotation": -maxRotation ... maxRotation,
            "elevation": 0 ... maxElevation, "textSize": minPositive ... maxTypography,
            "lineHeight": minPositive ... maxTypography, "letterSpacing": -maxTypography ... maxTypography,
        ],
    ]

    static func validate(_ spec: JSONValue) throws {
        try visit(spec, group: "spec", path: "")
    }

    private static func visit(_ value: JSONValue, group: String, path: String) throws {
        if case let .array(items) = value {
            for (index, item) in items.enumerated() {
                try visit(item, group: group, path: "\(path)[\(index)]")
            }
        }
        guard case let .object(fields) = value else { return }
        // The host and Kotlin visit object members in sorted UTF-16 order, regardless of JSON order.
        for key in fields.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
            guard let member = fields[key] else { continue }
            let childPath = path.isEmpty ? key : "\(path).\(key)"
            if let range = ranges[group]?[key], case let .number(number) = member,
               !number.isFinite || !range.contains(number)
            {
                throw DecodingError.dataCorrupted(.init(
                    codingPath: [], debugDescription: "\(childPath): Invalid number value"
                ))
            }
            if let childGroup = childGroup(group, key: key, fields: fields) {
                try visit(member, group: childGroup, path: childPath)
            }
        }
    }

    private static func childGroup(_ group: String, key: String, fields: [String: JSONValue]) -> String? {
        if let simple = childGroups[group]?[key] { return simple }
        if group == "window", key == "placement" {
            if case let .object(placement)? = fields[key], placement["type"]?.stringValue == "sheet" {
                return "sheet"
            }
            return "placement"
        }
        return nil
    }

    private static let childGroups: [String: [String: String]] = [
        "spec": ["root": "node", "window": "window"],
        "node": ["child": "node", "children": "node", "style": "style", "spans": "textSpan",
                 "styleWhen": "styleWhen", "animate": "animate", "zoomable": "zoomable",
                 "transition": "transition", "stagger": "stagger",
                 "anchor": "anchor", "detents": "detent"],
        "styleWhen": ["style": "style"],
        "textSpan": ["style": "textSpanStyle"],
        "anchor": ["bounds": "bounds", "offset": "offset"],
        "placement": ["offset": "offset"],
        "style": ["offset": "offset", "width": "dimension", "height": "dimension", "padding": "padding",
                  "border": "border", "cornerRadius": "cornerRadius"],
    ]
}
