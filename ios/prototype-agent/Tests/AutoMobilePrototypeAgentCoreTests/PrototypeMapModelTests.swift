@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeMapModelTests: XCTestCase {
    private func fixtureSpec(_ name: String) throws -> PrototypeSpec {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/valid/\(name).json")
        return try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: url))
    }

    private func fixture(_ name: String) throws -> (PrototypeNode, [String: JSONValue]) {
        let spec = try fixtureSpec(name)
        let node: PrototypeNode
        if spec.root.type == "map" { node = spec.root }
        else { node = try XCTUnwrap(spec.root.children?.first) }
        return (node, spec.data ?? [:])
    }

    private func decodeNode(_ fields: [String: JSONValue]) throws -> PrototypeNode {
        try JSONDecoder().decode(PrototypeNode.self, from: JSONEncoder().encode(JSONValue.object(fields)))
    }

    func testSharedMapCameraRowsRouteAndSummary() throws {
        let (node, data) = try fixture("map-node")
        let map = try PrototypeMap.model(node: node, data: data)
        XCTAssertEqual(map.camera?.center, PrototypeMapCoordinate(lat: 37.7749, lng: -122.4194))
        XCTAssertEqual(map.camera?.zoom, 13)
        XCTAssertEqual(map.markers.map(\.id), ["d1", "d2"])
        XCTAssertEqual(map.markers.map(\.title), ["Ana", "Ben"])
        XCTAssertEqual(map.markers.map(\.heading), [90, 270])
        XCTAssertEqual(map.markers.first?.animateMs, 1000)
        XCTAssertEqual(map.markers.first?.icon, "directions_car")
        XCTAssertEqual(map.routes.first?.points.count, 2)
        XCTAssertEqual(map.routes.first?.width, 4)
        XCTAssertEqual(map.routes.first?.color, "primary")
        XCTAssertEqual(
            map.bounds,
            PrototypeMapBounds(south: 37.771, north: 37.776, west: -122.425, east: -122.417, padding: 32)
        )
        XCTAssertTrue(map.showUserLocation)
        XCTAssertEqual(map.summary, "Map, 2 markers, 1 route")
        XCTAssertEqual(prototypeAccessibilityGrouping(type: "map", tappable: false), .contain)
    }

    func testInlineBoundaryCameraAndRouteFit() throws {
        let (node, data) = try fixture("map-node-limits")
        let map = try PrototypeMap.model(node: node, data: data)
        XCTAssertEqual(map.camera?.center, PrototypeMapCoordinate(lat: 90, lng: -180))
        XCTAssertEqual(map.camera?.zoom, 22)
        XCTAssertEqual(map.camera?.bearing, 360)
        XCTAssertEqual(map.camera?.tilt, 60)
        XCTAssertEqual(map.markers.first?.id, "0")
        XCTAssertEqual(map.markers.first?.title, "Stop 0")
        XCTAssertEqual(map.markers.first?.animateMs, 2000)
        XCTAssertEqual(map.routes.map(\.width), [1, 16, 2, 3, 4, 5, 6, 7])
        XCTAssertEqual(map.bounds, PrototypeMapBounds(south: 0, north: 0, west: 0, east: 0, padding: 32))
        XCTAssertNil(PrototypeMap.camera(nil, data: data))
        XCTAssertNil(PrototypeMap.camera(.object(["data": .string("/missing")]), data: data))
        XCTAssertEqual(PrototypeMap.camera(.object([
            "lat": .number(-90), "lng": .number(180), "zoom": .number(0),
            "bearing": .number(0), "tilt": .number(0),
        ]), data: nil)?.zoom, 0)
        XCTAssertNil(PrototypeMap.camera(.string("camera"), data: nil))
        XCTAssertNil(PrototypeMap.camera(.object([
            "lat": .string("0"), "lng": .number(0), "zoom": .number(0),
        ]), data: nil))
        for (field, invalid) in [("lat", 91.0), ("lng", -181), ("zoom", 23), ("bearing", 361), ("tilt", 61)] {
            var camera: [String: JSONValue] = ["lat": .number(0), "lng": .number(0), "zoom": .number(0)]
            camera[field] = .number(invalid)
            XCTAssertNil(PrototypeMap.camera(.object(camera), data: nil), field)
        }
    }

    func testInvalidMarkerAndRouteRowsAreSkippedAfterDataWrites() throws {
        let (node, original) = try fixture("map-node")
        var data = original
        data["drivers"] = .array([
            .object(["id": .string("good"), "name": .string("Here"), "lat": .number(-90), "lng": .number(180)]),
            .object(["lat": .number(91), "lng": .number(0)]),
            .object(["lat": .string("north"), "lng": .number(0)]),
            .object(["lat": .number(0), "lng": .number(-181)]), .bool(false),
        ])
        data["route"] = .object(["points": .array([
            .object(["lat": .number(0), "lng": .number(0)]),
            .object(["lat": .number(-91), "lng": .number(0)]),
            .object(["lat": .string("0"), "lng": .number(0)]),
        ])])
        let map = try PrototypeMap.model(node: node, data: data)
        XCTAssertEqual(map.markers.map(\.id), ["good"])
        XCTAssertEqual(map.routes.first?.points, [PrototypeMapCoordinate(lat: 0, lng: 0)])
    }

    func testSharedAssetIconAndDefaultRouteWidth() throws {
        let (node, data) = try fixture("map-marker-asset-icon")
        XCTAssertEqual(try PrototypeMap.model(node: node, data: data).markers.first?.asset, "car-pin")
        var templated = try XCTUnwrap(node.markers?.objectFields)
        templated["icon"] = .object(["asset": .string("pin-{index}")])
        let templatedNode = try decodeNode(["type": .string("map"), "markers": .object(templated)])
        XCTAssertEqual(try PrototypeMap.model(node: templatedNode, data: data).markers.first?.asset, "pin-0")
        let defaultNode = try decodeNode([
            "type": .string("map"), "polylines": .array([.object(["path": .string("/route")])]),
        ])
        let map = try PrototypeMap.model(node: defaultNode, data: data)
        XCTAssertEqual(map.routes.first?.width, 4)
        XCTAssertNil(map.routes.first?.color)
        XCTAssertNil(map.bounds)
        XCTAssertNil(map.camera)
    }

    func testMarkerLimitAtBoundaryAndDuplicateIds() throws {
        let (node, original) = try fixture("map-node-limits")
        let row: JSONValue = .object(["lat": .number(0), "lng": .number(0)])
        var data = original
        // This fixture has eight routes: isolate the marker cap from the total route cap.
        let markersOnly = try decodeNode(["type": .string("map"), "markers": XCTUnwrap(node.markers)])
        data["route"] = .array(Array(repeating: row, count: 500))
        XCTAssertEqual(try PrototypeMap.model(node: markersOnly, data: data).markers.count, 500)
        data["route"] = .array(Array(repeating: row, count: 500) + [.object(["lat": .number(91), "lng": .number(0)])])
        XCTAssertEqual(try PrototypeMap.model(node: markersOnly, data: data).markers.count, 500)
        data["route"] = .array(Array(repeating: row, count: 501))
        XCTAssertThrowsError(try PrototypeMap.model(node: markersOnly, data: data)) { error in
            XCTAssertTrue(String(describing: error).contains("Map marker limit exceeded (500)"))
        }
        var definition = try XCTUnwrap(node.markers?.objectFields)
        definition["id"] = .string("same")
        let duplicate = try decodeNode(["type": .string("map"), "markers": .object(definition)])
        data["route"] = .array([row, row])
        XCTAssertThrowsError(try PrototypeMap.model(node: duplicate, data: data)) { error in
            XCTAssertTrue(String(describing: error).contains("Duplicate marker id"))
        }
    }

    func testTotalPolylineLimitAtBoundary() throws {
        let (node, original) = try fixture("map-node-limits")
        var data = original
        let row: JSONValue = .object(["lat": .number(0), "lng": .number(0)])
        data["route"] = .array(Array(repeating: row, count: 250))
        XCTAssertEqual(try PrototypeMap.model(node: node, data: data).routes.flatMap(\.points).count, 2000)
        data["route"] = .array(Array(repeating: row, count: 251))
        XCTAssertThrowsError(try PrototypeMap.model(node: node, data: data))
        let single = try decodeNode([
            "type": .string("map"),
            "polylines": .array([XCTUnwrap(node.polylines?.first)]),
        ])
        data["route"] = .array(Array(repeating: row, count: 2000))
        XCTAssertEqual(try PrototypeMap.model(node: single, data: data).routes.first?.points.count, 2000)
        data["route"] = .array(Array(repeating: row, count: 2001))
        XCTAssertThrowsError(try PrototypeMap.model(node: single, data: data))
    }

    func testRepeatedMapDataPathsBindWithoutConsumingMarkerTemplates() throws {
        let row = PrototypeRepeatInstance(alias: "group", item: ["key": .string("east")], index: 4)
        let raw: JSONValue = .object([
            "type": .string("map"), "camera": .object(["data": .string("/cameras/{group.key}")]),
            "markers": .object([
                "path": .string("/drivers/{group.key}"), "as": .string("driver"),
                "id": .string("{driver.id}"), "lat": .string("{driver.lat}"),
                "lng": .string("{driver.lng}"), "title": .string("Stop {index}"),
            ]),
            "polylines": .array([.object(["path": .string("/routes/{group.key}")])]),
        ])
        let node = try JSONDecoder().decode(PrototypeNode.self, from: JSONEncoder().encode(row.bind(raw)))
        XCTAssertEqual(node.camera?.objectFields?["data"], .string("/cameras/east"))
        XCTAssertEqual(node.markers?.objectFields?["path"], .string("/drivers/east"))
        XCTAssertEqual(node.markers?.objectFields?["title"], .string("Stop {index}"))
        XCTAssertEqual(node.polylines?.first?.objectFields?["path"], .string("/routes/east"))
    }

    func testBackendFieldsReachEveryMapNode() throws {
        let spec = try fixtureSpec("map-backends")
        let nodes = try XCTUnwrap(spec.root.children)
        XCTAssertEqual(nodes.map(\.backend), [nil, "auto", "google", "maplibre"])
        for node in nodes {
            XCTAssertEqual(try PrototypeMap.model(node: node, data: spec.data).camera?.zoom, 13)
        }
    }

    func testZoomConversionAndOfflineDecision() {
        XCTAssertEqual(PrototypeMap.zoom(longitudeDelta: 360, viewportWidth: 256), 0)
        XCTAssertEqual(PrototypeMap.zoom(longitudeDelta: 360 / pow(2, 13), viewportWidth: 256), 13, accuracy: 0.00001)
        XCTAssertEqual(PrototypeMap.zoom(longitudeDelta: 0, viewportWidth: 256), 0)
        XCTAssertEqual(PrototypeMap.zoom(longitudeDelta: 0.00000001, viewportWidth: 256), 22)
        XCTAssertEqual(
            PrototypeMap.altitude(zoom: 10, latitude: 0, viewportHeight: 360) / PrototypeMap.altitude(
                zoom: 11,
                latitude: 0,
                viewportHeight: 360
            ),
            2,
            accuracy: 0.00001
        )
        XCTAssertTrue(PrototypeMap.altitude(zoom: 22, latitude: 90, viewportHeight: 360).isFinite)
        XCTAssertEqual(
            PrototypeMap.style(nil, networkAllowed: true),
            PrototypeMapStyle(streets: false, offlineChip: false)
        )
        XCTAssertEqual(
            PrototypeMap.style("streets", networkAllowed: false),
            PrototypeMapStyle(streets: false, offlineChip: true)
        )
        XCTAssertEqual(
            PrototypeMap.style("streets"),
            PrototypeMapStyle(streets: false, offlineChip: true)
        )
        XCTAssertEqual(
            PrototypeMap.style("streets", networkAllowed: nil),
            PrototypeMapStyle(streets: false, offlineChip: true)
        )
        XCTAssertEqual(
            PrototypeMap.style("streets", networkAllowed: true),
            PrototypeMapStyle(streets: true, offlineChip: false)
        )
        XCTAssertEqual(
            PrototypeMap.style("plain", networkAllowed: false),
            PrototypeMapStyle(streets: false, offlineChip: false)
        )
        XCTAssertTrue(AutoMobilePrototypeCapabilities.supported.contains("prototype_platform_map_v1"))
        XCTAssertFalse(AutoMobilePrototypeCapabilities.supported.contains("prototype_platform_map_google_v1"))
        XCTAssertFalse(AutoMobilePrototypeCapabilities.supported.contains("prototype_platform_map_maplibre_v1"))
    }

    func testSharedMarkerActionsBindRowAndPreserveRuntimeEmitContext() throws {
        let (node, data) = try fixture("map-marker-tap-emit-context")
        let marker = try XCTUnwrap(PrototypeMap.model(node: node, data: data).markers.first)
        let actions = try PrototypeMap.markerActions(node.onMarkerTap ?? [], marker: marker)
        XCTAssertEqual(actions.first?.value, .string("d1"))
        XCTAssertEqual(actions.last?.mapMarkerId, "d1")
        var session = PrototypeSession()
        try session.show(fixtureSpec("map-marker-tap-emit-context"))
        let events = session.run(actions)
        XCTAssertEqual(session.state["selectedDriver"], .string("d1"))
        XCTAssertEqual(events.first(where: { $0.name == "driver_selected" })?.context, [
            "driver": .string("Ana"), "selected": .string("d1"), "markerId": .string("d1"),
        ])
        XCTAssertEqual(actions.last?.context?.bindings["driver"], .object(["value": .string("Ana")]))
        XCTAssertEqual(actions.last?.context?.bindings["selected"], .object(["state": .string("selectedDriver")]))
        let nested: JSONValue = .object([
            "type": .string("startTimer"), "id": .string("later"), "afterMs": .number(100),
            "actions": .array([.object(["type": .string("emit"), "name": .string("later")])]),
        ])
        XCTAssertEqual(
            try PrototypeMap.markerActions([nested], marker: marker).first?.actions?.first?.mapMarkerId,
            "d1"
        )
    }

    func testAuthoredLabelsWinOverMapSummary() throws {
        let node = try decodeNode(["type": .string("map")])
        XCTAssertEqual(node.mapLabel(data: nil, state: [:]), "Map, 0 markers, 0 routes")
        let description = try decodeNode(["type": .string("map"), "contentDescription": .string("Ride {selected}")])
        XCTAssertEqual(description.mapLabel(data: nil, state: ["selected": .string("home")]), "Ride home")
        let semantics = try decodeNode([
            "type": .string("map"), "contentDescription": .string("Description"),
            "semantics": .object(["label": .string("Custom map")]),
        ])
        XCTAssertEqual(semantics.mapLabel(data: nil, state: [:]), "Custom map")
    }

    func testCameraIdleUsesDataWriteAction() throws {
        let (node, data) = try fixture("map-node")
        let camera = try XCTUnwrap(PrototypeMap.model(node: node, data: data).camera)
        let action = try PrototypeMap.cameraAction(into: "/data/lastCamera", camera: camera)
        XCTAssertEqual(action.type, "setData")
        XCTAssertEqual(action.path, "/data/lastCamera")
        XCTAssertEqual(action.value, .object(["value": camera.value]))
        let written = try PrototypeDataWrite.apply(data, op: .set, path: "/data/lastCamera", value: camera.value).get()
        XCTAssertEqual(written["lastCamera"], camera.value)
    }

    private func driftedCamera(_ camera: PrototypeMapCamera) -> PrototypeMapCamera {
        PrototypeMapCamera(
            center: PrototypeMapCoordinate(lat: camera.center.lat + 0.00000001, lng: camera.center.lng - 0.00000001),
            zoom: camera.zoom + 0.0001, bearing: camera.bearing + 0.001, tilt: camera.tilt + 0.001
        )
    }

    func testIdleCameraRoundsEveryField() throws {
        let raw = PrototypeMapCamera(
            center: PrototypeMapCoordinate(lat: 37.7749126, lng: -122.4194126),
            zoom: 13.126, bearing: 90.16, tilt: 30.16
        )
        let rounded = try XCTUnwrap(PrototypeMap.idleCamera(raw, lastCamera: nil))
        XCTAssertEqual(rounded, PrototypeMapCamera(
            center: PrototypeMapCoordinate(lat: 37.774913, lng: -122.419413),
            zoom: 13.13, bearing: 90.2, tilt: 30.2
        ))
        XCTAssertEqual(rounded.rounded, rounded)
    }

    func testIdleCameraDeduplicatesSubPrecisionDrift() {
        let raw = PrototypeMapCamera(
            center: PrototypeMapCoordinate(lat: 37.7749001, lng: -122.4194001),
            zoom: 13.001, bearing: 90.01, tilt: 30.01
        )
        XCTAssertNil(PrototypeMap.idleCamera(driftedCamera(raw), lastCamera: raw))
        XCTAssertNil(PrototypeMap.idleCamera(driftedCamera(raw.rounded), lastCamera: raw.rounded))
    }

    func testIdleCameraWritesChangesBeyondPrecision() throws {
        let previous = PrototypeMapCamera(
            center: PrototypeMapCoordinate(lat: 37.7749, lng: -122.4194), zoom: 13, bearing: 90, tilt: 30
        )
        for (field, value) in [
            ("lat", 37.774901), ("lng", -122.419401), ("zoom", 13.01), ("bearing", 90.1), ("tilt", 30.1),
        ] {
            var fields = try XCTUnwrap(previous.value.objectFields)
            fields[field] = .number(value)
            let moved = try XCTUnwrap(PrototypeMap.camera(.object(fields), data: nil))
            XCTAssertEqual(PrototypeMap.idleCamera(moved, lastCamera: previous)?.value, .object(fields), field)
        }
    }

    func testBoundCameraDoesNotLoop() throws {
        let initial = PrototypeMapCamera(
            center: PrototypeMapCoordinate(lat: 37.7749, lng: -122.4194), zoom: 13, bearing: 90, tilt: 30
        )
        var data = ["camera": initial.value]
        let binding: JSONValue = .object(["data": .string("/camera")])
        var lastCamera = try XCTUnwrap(PrototypeMap.camera(binding, data: data)).rounded
        XCTAssertNil(PrototypeMap.idleCamera(driftedCamera(initial), lastCamera: lastCamera))

        let moved = PrototypeMapCamera(center: initial.center, zoom: 14, bearing: 90, tilt: 30)
        let written = try XCTUnwrap(PrototypeMap.idleCamera(driftedCamera(moved), lastCamera: lastCamera))
        XCTAssertEqual(written, moved)
        lastCamera = written
        XCTAssertNil(PrototypeMap.idleCamera(driftedCamera(moved), lastCamera: lastCamera))
        data = try PrototypeDataWrite.apply(data, op: .set, path: "/data/camera", value: written.value).get()

        let applied = try XCTUnwrap(PrototypeMap.camera(binding, data: data))
        lastCamera = applied.rounded
        XCTAssertNil(PrototypeMap.idleCamera(driftedCamera(applied), lastCamera: lastCamera))
    }
}
