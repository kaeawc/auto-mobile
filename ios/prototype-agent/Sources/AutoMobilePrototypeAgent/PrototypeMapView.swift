#if canImport(UIKit)
    import MapKit
    import SwiftUI
    import UIKit

    private struct PrototypeMapNetworkKey: EnvironmentKey {
        static let defaultValue = true
    }

    extension EnvironmentValues {
        var prototypeMapNetworkAllowed: Bool {
            get { self[PrototypeMapNetworkKey.self] }
            set { self[PrototypeMapNetworkKey.self] = newValue }
        }
    }

    @MainActor
    struct PrototypeMapView: View {
        @Environment(\.prototypePalette) private var palette
        @Environment(\.prototypeMapNetworkAllowed) private var networkAllowed
        let node: PrototypeNode
        let model: PrototypeModel

        var body: some View {
            let result = Result { try PrototypeMap.model(node: node, data: model.spec?.data) }
            let style = PrototypeMap.style(node.mapStyle, networkAllowed: networkAllowed)
            switch result {
            case let .success(map):
                PrototypeNativeMap(node: node, model: model, map: map, style: style, palette: palette)
                    // Recreate on consent changes so pending MapKit tile work is discarded too.
                    .id(style.streets)
                    .overlay(alignment: .topTrailing) {
                        if style.offlineChip {
                            Text("Offline map")
                                .font(.caption)
                                .padding(6)
                                .background(.regularMaterial, in: Capsule())
                                .padding(8)
                        }
                    }
                    .frame(minHeight: 0, idealHeight: 360)
            case let .failure(error):
                Text("Map unavailable: \(String(describing: error))")
                    .font(.caption)
            }
        }
    }

    /// Replaces Apple's base map with a fixed local tile. No URL template or URLSession is involved.
    private final class PrototypePlainMapTiles: MKTileOverlay, @unchecked Sendable {
        private let tile: Data

        override init(urlTemplate: String?) {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = true
            let renderer = UIGraphicsImageRenderer(size: CGSize(width: 256, height: 256), format: format)
            tile = renderer.pngData { context in
                UIColor(red: 0.94, green: 0.95, blue: 0.93, alpha: 1).setFill()
                context.fill(CGRect(x: 0, y: 0, width: 256, height: 256))
                UIColor(red: 0.86, green: 0.88, blue: 0.85, alpha: 1).setStroke()
                context.cgContext.setLineWidth(1)
                context.cgContext.stroke(CGRect(x: 0.5, y: 0.5, width: 255, height: 255))
            }
            super.init(urlTemplate: nil)
            canReplaceMapContent = true
        }

        override func loadTile(at _: MKTileOverlayPath, result: @escaping (Data?, Error?) -> Void) {
            result(tile, nil)
        }
    }

    @MainActor
    private final class PrototypeMapSurface: MKMapView {
        var onLayout: (() -> Void)?
        private var lastSize: CGSize = .zero

        override func layoutSubviews() {
            super.layoutSubviews()
            guard bounds.size != lastSize, bounds.width > 0, bounds.height > 0 else { return }
            lastSize = bounds.size
            onLayout?()
        }
    }

    private final class PrototypeMapAnnotation: NSObject, MKAnnotation {
        @objc dynamic var coordinate: CLLocationCoordinate2D
        var marker: PrototypeMapMarker
        var title: String? { marker.title }

        init(_ marker: PrototypeMapMarker) {
            self.marker = marker
            coordinate = CLLocationCoordinate2D(latitude: marker.coordinate.lat, longitude: marker.coordinate.lng)
        }
    }

    @MainActor
    private struct PrototypeNativeMap: UIViewRepresentable {
        let node: PrototypeNode
        let model: PrototypeModel
        let map: PrototypeMapModel
        let style: PrototypeMapStyle
        let palette: PrototypePalette

        func makeCoordinator() -> Coordinator { Coordinator(self) }

        func makeUIView(context: Context) -> MKMapView {
            let view = PrototypeMapSurface(frame: .zero)
            view.onLayout = { [weak view, weak coordinator = context.coordinator] in
                guard let view else { return }
                coordinator?.updateCamera(view, force: true)
            }
            view.delegate = context.coordinator
            view.mapType = .standard
            view.pointOfInterestFilter = .excludingAll
            view.showsTraffic = false
            view.showsBuildings = false
            if !style.streets { view.addOverlay(PrototypePlainMapTiles(urlTemplate: nil), level: .aboveLabels) }
            view.setRegion(MKCoordinateRegion(
                center: CLLocationCoordinate2D(latitude: 0, longitude: 0),
                span: MKCoordinateSpan(latitudeDelta: 90, longitudeDelta: 180)
            ), animated: false)
            return view
        }

        func updateUIView(_ view: MKMapView, context: Context) {
            let coordinator = context.coordinator
            coordinator.parent = self
            view.accessibilityIdentifier = node.testTag ?? node.id
            view.accessibilityLabel = node.mapLabel(data: model.spec?.data, state: model.state)
            // Reading authorization never requests it. The location module owns prompts.
            let authorization = coordinator.location.authorization
            view.showsUserLocation = map.showUserLocation &&
                (authorization == .authorizedPrecise || authorization == .authorizedApproximate)
            coordinator.updateAnnotations(view)
            if coordinator.routes != map.routes || coordinator.routePalette != palette {
                coordinator.routePalette = palette
                view.removeOverlays(view.overlays.filter { $0 is MKPolyline })
                coordinator.routes = map.routes
                coordinator.lines.removeAll()
                for route in map.routes where route.points.count >= 2 {
                    let coordinates = route.points.map {
                        CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng)
                    }
                    let line = MKPolyline(coordinates: coordinates, count: coordinates.count)
                    coordinator.lines[ObjectIdentifier(line)] = route
                    view.addOverlay(line, level: .aboveLabels)
                }
            }
            coordinator.updateCamera(view)
        }

        static func dismantleUIView(_ view: MKMapView, coordinator: Coordinator) {
            coordinator.active = false
            view.delegate = nil
            view.showsUserLocation = false
            view.removeOverlays(view.overlays)
        }

        @MainActor
        final class Coordinator: NSObject, MKMapViewDelegate {
            var parent: PrototypeNativeMap
            let location = CLLocationManagerPrototypeLocationSource()
            var active = true
            var camera: PrototypeMapCamera?
            var bounds: PrototypeMapBounds?
            var routePalette: PrototypePalette?
            var routes: [PrototypeMapRoute] = []
            var lines: [ObjectIdentifier: PrototypeMapRoute] = [:]
            private var lastIdle: PrototypeMapCamera?

            init(_ parent: PrototypeNativeMap) { self.parent = parent }

            func updateCamera(_ view: MKMapView, force: Bool = false) {
                guard view.bounds.width > 0, view.bounds.height > 0 else { return }
                if camera != parent.map.camera || force {
                    camera = parent.map.camera
                    if let camera = parent.map.camera {
                        let native = MKMapCamera(
                            lookingAtCenter: CLLocationCoordinate2D(
                                latitude: camera.center.lat,
                                longitude: camera.center.lng
                            ),
                            fromDistance: PrototypeMap.altitude(
                                zoom: camera.zoom, latitude: camera.center.lat,
                                viewportHeight: Double(view.bounds.height)
                            ), pitch: CGFloat(camera.tilt), heading: camera.bearing
                        )
                        view.setCamera(native, animated: false)
                    }
                }
                if bounds != parent.map.bounds || force {
                    bounds = parent.map.bounds
                    if let bounds = parent.map.bounds {
                        let region = MKCoordinateRegion(
                            center: CLLocationCoordinate2D(
                                latitude: (bounds.south + bounds.north) / 2, longitude: (bounds.west + bounds.east) / 2
                            ),
                            span: MKCoordinateSpan(
                                latitudeDelta: Swift.max(0.002, bounds.north - bounds.south),
                                longitudeDelta: Swift.max(0.002, bounds.east - bounds.west)
                            )
                        )
                        let topLeft = MKMapPoint(CLLocationCoordinate2D(
                            latitude: Swift.max(
                                -85.05112878,
                                Swift.min(85.05112878, region.center.latitude + region.span.latitudeDelta / 2)
                            ),
                            longitude: region.center.longitude - region.span.longitudeDelta / 2
                        ))
                        let bottomRight = MKMapPoint(CLLocationCoordinate2D(
                            latitude: Swift.max(
                                -85.05112878,
                                Swift.min(85.05112878, region.center.latitude - region.span.latitudeDelta / 2)
                            ),
                            longitude: region.center.longitude + region.span.longitudeDelta / 2
                        ))
                        view.setVisibleMapRect(MKMapRect(
                            x: topLeft.x, y: topLeft.y, width: Swift.max(1, bottomRight.x - topLeft.x),
                            height: Swift.max(1, bottomRight.y - topLeft.y)
                        ), edgePadding: UIEdgeInsets(
                            top: CGFloat(bounds.padding), left: CGFloat(bounds.padding),
                            bottom: CGFloat(bounds.padding), right: CGFloat(bounds.padding)
                        ), animated: false)
                    }
                }
            }

            func updateAnnotations(_ view: MKMapView) {
                let existing = view.annotations.compactMap { $0 as? PrototypeMapAnnotation }
                let ids = Set(parent.map.markers.map { Array($0.id.utf16) })
                view.removeAnnotations(existing.filter { !ids.contains(Array($0.marker.id.utf16)) })
                let byId = Dictionary(uniqueKeysWithValues: existing.map { (Array($0.marker.id.utf16), $0) })
                for marker in parent.map.markers {
                    if let annotation = byId[Array(marker.id.utf16)] {
                        let moved = annotation.marker.coordinate != marker.coordinate
                        annotation.marker = marker
                        if moved {
                            UIView.animate(withDuration: marker.animateMs / 1000) {
                                annotation.coordinate = CLLocationCoordinate2D(
                                    latitude: marker.coordinate.lat, longitude: marker.coordinate.lng
                                )
                            }
                        }
                        if let drawn = view.view(for: annotation) { configure(drawn, marker) }
                    } else { view.addAnnotation(PrototypeMapAnnotation(marker)) }
                }
            }

            func mapView(_ mapView: MKMapView, viewFor annotation: any MKAnnotation) -> MKAnnotationView? {
                guard let annotation = annotation as? PrototypeMapAnnotation else { return nil }
                let view = mapView.dequeueReusableAnnotationView(withIdentifier: "prototype-marker") ??
                    MKAnnotationView(annotation: annotation, reuseIdentifier: "prototype-marker")
                view.annotation = annotation
                configure(view, annotation.marker)
                return view
            }

            private func configure(_ view: MKAnnotationView, _ marker: PrototypeMapMarker) {
                var icon = marker.asset.flatMap { parent.model.assets[$0] }
                if icon == nil {
                    let glyph: UIImage? = switch PrototypeIconSymbolTable.shared.resolve(marker.icon) {
                    case let .symbol(symbol, fallback):
                        UIImage(systemName: symbol) ?? fallback.flatMap { UIImage(systemName: $0) }
                    case .placeholder, .unknown:
                        UIImage(systemName: marker.icon == nil ? "mappin.circle.fill" : "questionmark.square")
                    }
                    icon = glyph?.withTintColor(.systemBlue, renderingMode: .alwaysOriginal)
                }
                view.image = UIGraphicsImageRenderer(size: CGSize(width: 120, height: 60)).image { context in
                    context.cgContext.saveGState()
                    context.cgContext.translateBy(x: 60, y: 18)
                    context.cgContext.rotate(by: CGFloat(marker.heading * .pi / 180))
                    if let icon {
                        let scale = 28 / Swift.max(1, Swift.max(icon.size.width, icon.size.height))
                        let width = icon.size.width * scale
                        let height = icon.size.height * scale
                        icon.draw(in: CGRect(x: -width / 2, y: -height / 2, width: width, height: height))
                    }
                    context.cgContext.restoreGState()
                    let paragraph = NSMutableParagraphStyle()
                    paragraph.alignment = .center
                    paragraph.lineBreakMode = .byTruncatingTail
                    (marker.title as NSString).draw(in: CGRect(x: 0, y: 36, width: 120, height: 24), withAttributes: [
                        .font: UIFont.systemFont(ofSize: 12), .foregroundColor: UIColor.label,
                        .backgroundColor: UIColor.systemBackground, .paragraphStyle: paragraph,
                    ])
                }
                view.centerOffset = CGPoint(x: 0, y: 12)
                view.isAccessibilityElement = true
                view.accessibilityLabel = marker.title
                view.accessibilityTraits = .button
                view.accessibilityIdentifier = "\(parent.node.id ?? parent.node.testTag ?? "map")/marker/\(marker.id)"
            }

            func mapView(_ mapView: MKMapView, didSelect view: MKAnnotationView) {
                guard let annotation = view.annotation as? PrototypeMapAnnotation else { return }
                if let actions = try? PrototypeMap.markerActions(
                    parent.node.onMarkerTap ?? [],
                    marker: annotation.marker
                ) {
                    parent.model.run(actions)
                }
                mapView.deselectAnnotation(annotation, animated: false)
            }

            func mapView(_: MKMapView, rendererFor overlay: any MKOverlay) -> MKOverlayRenderer {
                if let tile = overlay as? MKTileOverlay { return MKTileOverlayRenderer(tileOverlay: tile) }
                if let line = overlay as? MKPolyline, let route = lines[ObjectIdentifier(line)] {
                    let renderer = MKPolylineRenderer(polyline: line)
                    renderer.lineWidth = CGFloat(route.width)
                    renderer.strokeColor = (parent.palette.color(route.color) ?? parent.palette.color("primary"))
                        .map { UIColor($0) } ?? .systemBlue
                    return renderer
                }
                return MKOverlayRenderer(overlay: overlay)
            }

            func mapView(_ mapView: MKMapView, regionDidChangeAnimated _: Bool) {
                guard active, mapView.bounds.width > 0,
                      let into = parent.node.onCameraIdle?["into"]?.stringValue else { return }
                let camera = PrototypeMapCamera(
                    center: PrototypeMapCoordinate(
                        lat: mapView.centerCoordinate.latitude,
                        lng: mapView.centerCoordinate.longitude
                    ),
                    zoom: PrototypeMap.zoom(
                        longitudeDelta: mapView.region.span.longitudeDelta,
                        viewportWidth: Double(mapView.bounds.width)
                    ),
                    bearing: mapView.camera.heading, tilt: Double(mapView.camera.pitch)
                )
                guard camera != lastIdle else { return }
                lastIdle = camera
                // A programmatic camera change may report while SwiftUI is updating the view.
                Task { @MainActor [weak self] in
                    guard let self, active, lastIdle == camera,
                          parent.node.onCameraIdle?["into"]?.stringValue == into,
                          let action = try? PrototypeMap.cameraAction(into: into, camera: camera) else { return }
                    parent.model.run([action])
                }
            }
        }
    }
#endif
