import Foundation

struct PrototypeMapCoordinate: Equatable, Sendable {
    let lat: Double
    let lng: Double
}

struct PrototypeMapCamera: Equatable, Sendable {
    let center: PrototypeMapCoordinate
    let zoom: Double
    let bearing: Double
    let tilt: Double

    var value: JSONValue {
        .object([
            "lat": .number(center.lat), "lng": .number(center.lng), "zoom": .number(zoom),
            "bearing": .number(bearing), "tilt": .number(tilt),
        ])
    }
}

struct PrototypeMapMarker: Equatable, Sendable {
    let id: String
    let coordinate: PrototypeMapCoordinate
    let title: String
    let icon: String?
    let asset: String?
    let heading: Double
    let animateMs: Double
    let row: [String: JSONValue]
    let index: Int
    let alias: String
}

struct PrototypeMapRoute: Equatable, Sendable {
    let points: [PrototypeMapCoordinate]
    let width: Double
    let color: PrototypeModeValue?
}

struct PrototypeMapBounds: Equatable, Sendable {
    let south: Double
    let north: Double
    let west: Double
    let east: Double
    let padding: Double
}

struct PrototypeMapStyle: Equatable, Sendable {
    let streets: Bool
    let offlineChip: Bool
}

struct PrototypeMapModel: Equatable, Sendable {
    let camera: PrototypeMapCamera?
    let markers: [PrototypeMapMarker]
    let routes: [PrototypeMapRoute]
    let bounds: PrototypeMapBounds?
    let showUserLocation: Bool

    var summary: String {
        "Map, \(markers.count) \(markers.count == 1 ? "marker" : "markers"), " +
            "\(routes.count) \(routes.count == 1 ? "route" : "routes")"
    }
}

extension PrototypeMap {
    static let maxMarkers = 500
    static let maxPoints = 2000

    /// MapKit is the only iOS backend. Imported streets require the live library consent switch.
    static func style(_ requested: String?, networkAllowed: Bool) -> PrototypeMapStyle {
        let streets = requested == "streets"
        return PrototypeMapStyle(streets: streets && networkAllowed, offlineChip: streets && !networkAllowed)
    }

    static func camera(_ raw: JSONValue?, data: [String: JSONValue]?) -> PrototypeMapCamera? {
        var fields = raw?.objectFields
        if let pointer = fields?["data"]?.stringValue {
            fields = PrototypeDataPointer.resolve(data, pointer: pointer)?.objectFields
        }
        guard let fields, let center = coordinate(fields), let zoom = number(fields["zoom"]),
              (0 ... 22).contains(zoom)
        else { return nil }
        let bearing: Double? = fields["bearing"] == nil ? 0 : number(fields["bearing"])
        let tilt: Double? = fields["tilt"] == nil ? 0 : number(fields["tilt"])
        guard let bearing, let tilt, (0 ... 360).contains(bearing), (0 ... 60).contains(tilt) else { return nil }
        return PrototypeMapCamera(center: center, zoom: zoom, bearing: bearing, tilt: tilt)
    }

    /// Web-Mercator zoom: 256 point tiles, latitude-adjusted ground span and a 30 degree vertical FOV.
    static func altitude(zoom: Double, latitude: Double, viewportHeight: Double) -> Double {
        let latitude = Swift.min(85.05112878, Swift.max(-85.05112878, latitude))
        let metersPerPoint = 40_075_016.686 * cos(latitude * .pi / 180) / (256 * pow(2, zoom))
        return Swift.max(1, metersPerPoint * Swift.max(1, viewportHeight) / (2 * tan(.pi / 12)))
    }

    static func zoom(longitudeDelta: Double, viewportWidth: Double) -> Double {
        guard longitudeDelta.isFinite, longitudeDelta > 0, viewportWidth > 0 else { return 0 }
        return Swift.min(22, Swift.max(0, log2(360 * viewportWidth / (256 * longitudeDelta))))
    }

    static func model(node: PrototypeNode, data: [String: JSONValue]?) throws -> PrototypeMapModel {
        let markers = try Self.markers(node: node, data: data)
        let routes = try Self.routes(node: node, data: data)
        let points: [PrototypeMapCoordinate] = switch node.fit {
        case "markers": markers.map(\.coordinate)
        case "route": routes.flatMap(\.points)
        default: []
        }
        return PrototypeMapModel(
            camera: camera(node.camera, data: data), markers: markers, routes: routes,
            bounds: bounds(points), showUserLocation: node.showUserLocation ?? false
        )
    }

    private static func markers(node: PrototypeNode, data: [String: JSONValue]?) throws -> [PrototypeMapMarker] {
        let path = node.nodePath
        var markers: [PrototypeMapMarker] = []
        if let definition = node.markers?.objectFields,
           let pointer = definition["path"]?.stringValue, let alias = definition["as"]?.stringValue
        {
            let items = rows(pointer, data: data)
            var ids = Set<[UInt16]>()
            for (index, item) in items.enumerated() {
                guard let row = item.objectFields else { continue }
                let instance = PrototypeRepeatInstance(alias: alias, item: row, index: index)
                func text(_ key: String) -> String { instance.interpolate(definition[key]?.stringValue ?? "") }
                guard let lat = Double(text("lat")), let lng = Double(text("lng")),
                      let point = coordinate(["lat": .number(lat), "lng": .number(lng)]) else { continue }
                guard markers.count < maxMarkers else {
                    throw PrototypeLimits.violation("\(path).markers", "Map marker limit exceeded (500)")
                }
                let id = text("id")
                guard ids.insert(Array(id.utf16)).inserted else {
                    throw PrototypeLimits.violation(
                        "\(path).markers.id",
                        "Duplicate marker id \(PrototypeContractValidator.quoted(id))"
                    )
                }
                let icon = definition["icon"]
                markers.append(PrototypeMapMarker(
                    id: id, coordinate: point, title: text("title"),
                    icon: icon?.stringValue,
                    asset: icon?.objectFields?["asset"]?.stringValue.map(instance.interpolate),
                    heading: Double(text("heading")).flatMap { $0.isFinite ? $0 : nil } ?? 0,
                    animateMs: number(definition["animateMs"]) ?? 0, row: row, index: index, alias: alias
                ))
            }
        }
        return markers
    }

    private static func routes(node: PrototypeNode, data: [String: JSONValue]?) throws -> [PrototypeMapRoute] {
        var routes: [PrototypeMapRoute] = []
        var total = 0
        for (index, raw) in (node.polylines ?? []).enumerated() {
            guard let definition = raw.objectFields, let path = definition["path"]?.stringValue else { continue }
            let items = rows(path, data: data)
            let points = items.compactMap { $0.objectFields.flatMap(coordinate) }
            total += points.count
            guard total <= maxPoints else {
                throw PrototypeLimits.violation(
                    "\(node.nodePath).polylines[\(index)]",
                    "Map polyline point limit exceeded (2000)"
                )
            }
            let color = try definition["color"].map {
                try JSONDecoder().decode(PrototypeModeValue.self, from: JSONEncoder().encode($0))
            }
            routes.append(PrototypeMapRoute(
                points: points,
                width: number(definition["width"]) ?? 4, color: color
            ))
        }
        return routes
    }

    static func bounds(_ points: [PrototypeMapCoordinate]) -> PrototypeMapBounds? {
        guard let first = points.first else { return nil }
        return PrototypeMapBounds(
            south: points.map(\.lat).min() ?? first.lat, north: points.map(\.lat).max() ?? first.lat,
            west: points.map(\.lng).min() ?? first.lng, east: points.map(\.lng).max() ?? first.lng, padding: 32
        )
    }

    private static func rows(_ path: String, data: [String: JSONValue]?) -> [JSONValue] {
        guard case let .array(items)? = PrototypeDataPointer.resolve(data, pointer: path) else { return [] }
        return items
    }

    private static func coordinate(_ fields: [String: JSONValue]) -> PrototypeMapCoordinate? {
        guard let lat = number(fields["lat"]), let lng = number(fields["lng"]),
              (-90 ... 90).contains(lat), (-180 ... 180).contains(lng) else { return nil }
        return PrototypeMapCoordinate(lat: lat, lng: lng)
    }

    private static func number(_ value: JSONValue?) -> Double? {
        guard case let .number(value)? = value, value.isFinite else { return nil }
        return value
    }

    /// Bind at tap time; stamp the runtime context on nested callbacks/timers as well as direct emits.
    static func markerActions(_ raw: [JSONValue], marker: PrototypeMapMarker) throws -> [PrototypeAction] {
        let row = PrototypeRepeatInstance(alias: marker.alias, item: marker.row, index: marker.index)
        func bind(_ raw: JSONValue) -> JSONValue {
            guard var action = raw.objectFields else { return raw }
            if action["type"] == .string("emit") {
                action["_mapMarkerId"] = .string(marker.id)
                if let context = action["context"]?.objectFields {
                    action["context"] = .object(context.mapValues { binding in
                        guard var fields = binding.objectFields else { return binding }
                        if let value = fields["value"] { fields["value"] = row.interpolateScalar(value) }
                        return .object(fields)
                    })
                }
            }
            for key in ["actions", "onSuccess", "onError"] {
                if case let .array(items)? = action[key] { action[key] = .array(items.map(bind)) }
            }
            return .object(action)
        }
        return try JSONDecoder().decode(
            [PrototypeAction].self,
            from: JSONEncoder().encode(JSONValue.array(raw.map { bind(row.bindAction($0)) }))
        )
    }

    static func cameraAction(into: String, camera: PrototypeMapCamera) throws -> PrototypeAction {
        let raw: JSONValue = .object([
            "type": .string("setData"), "path": .string(into), "value": .object(["value": camera.value]),
        ])
        return try JSONDecoder().decode(PrototypeAction.self, from: JSONEncoder().encode(raw))
    }
}

extension PrototypeNode {
    func mapLabel(data: [String: JSONValue]?, state: [String: JSONValue]) -> String? {
        accessibilityLabel(state: state, pager: nil, tappable: false)
            ?? (try? PrototypeMap.model(node: self, data: data))?.summary
    }
}
