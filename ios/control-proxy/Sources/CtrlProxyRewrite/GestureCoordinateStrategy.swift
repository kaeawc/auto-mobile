import Foundation

struct GestureSize: Equatable, Hashable, Sendable {
    let width: Double
    let height: Double

    var isValid: Bool { width.isFinite && height.isFinite && width > 0 && height > 0 }
}

struct GesturePoint: Equatable, Sendable {
    let x: Double
    let y: Double

    static let zero = GesturePoint(x: 0, y: 0)
}

/// No platform types or reads: a transpose is an ordinary single-panel rotation.
nonisolated func hasMultiPanelMismatch(app: GestureSize, screen: GestureSize) -> Bool {
    guard app.isValid, screen.isValid else { return false }
    let tolerance = 1.0
    let same = abs(app.width - screen.width) <= tolerance && abs(app.height - screen.height) <= tolerance
    let transposed = abs(app.width - screen.height) <= tolerance && abs(app.height - screen.width) <= tolerance
    return !same && !transposed
}

enum TapCoordinateStrategy: String, Equatable, Sendable {
    case legacy
    case appRelative
    case appRelativeObserved
    case displayTargeted
    case displayTargetedObserved

    var targetsDisplay: Bool { self == .displayTargeted || self == .displayTargetedObserved }
}

enum GestureCoordinateAnchor: Equatable, Sendable {
    case legacyApplication
    case observedApplication
}

struct GestureCoordinateGeometry: Equatable, Sendable {
    let app: GestureSize
    let screen: GestureSize
    let observation: GestureSize
    let rotation: Int?

    nonisolated func replacingScreen(_ screen: GestureSize) -> Self {
        Self(app: app, screen: screen, observation: observation, rotation: rotation)
    }

    /// Correct only a runner-screen mismatch that disappears against the trusted screen.
    nonisolated func resolvingSinglePanel(reference: GestureSize?) -> Self? {
        guard hasMultiPanelMismatch(app: app, screen: screen),
              let reference, reference.isValid,
              !hasMultiPanelMismatch(app: app, screen: reference) else { return nil }
        return replacingScreen(reference)
    }

    /// Mirrors resolveIosObserveRotation: unknown cardinal orientation falls back to size.
    nonisolated static func observationRotation(_ rotation: Int?, size: GestureSize) -> Int? {
        guard size.isValid else { return nil }
        if let rotation, (0 ... 3).contains(rotation),
           !(size.width < size.height && (rotation == 1 || rotation == 3))
        {
            return rotation
        }
        return size.width < size.height ? 0 : 1
    }
}

/// Memoizes failures too, so an unavailable reference does not add IPC to every tap.
@MainActor
final class ReferenceScreenCache {
    private struct Key: Hashable {
        let app: GestureSize
        let screen: GestureSize

        init(_ geometry: GestureCoordinateGeometry) {
            app = geometry.app
            screen = geometry.screen
        }
    }

    private struct Entry {
        let screen: GestureSize?
    }

    private let reader: @MainActor () -> GestureSize?
    private var entries: [Key: Entry] = [:]

    init(reader: @escaping @MainActor () -> GestureSize?) { self.reader = reader }

    func screen(for geometry: GestureCoordinateGeometry) -> GestureSize? {
        let key = Key(geometry)
        if let entry = entries[key] { return entry.screen }
        let result = reader()
        let screen = result.flatMap { $0.isValid ? $0 : nil }
        entries[key] = Entry(screen: screen)
        return screen
    }

    /// Forced legacy can consume a warm entry, but must never trigger a platform read.
    func cachedScreen(for geometry: GestureCoordinateGeometry) -> GestureSize? {
        entries[Key(geometry)]?.screen
    }
}

struct GestureCoordinateSelection: Equatable, Sendable {
    let strategy: TapCoordinateStrategy
    let reason: String
    let normalized: GesturePoint
    let offset: GesturePoint?

    var anchor: GestureCoordinateAnchor {
        strategy == .legacy ? .legacyApplication : .observedApplication
    }

    nonisolated static func mappedOffset(
        point: GesturePoint, geometry: GestureCoordinateGeometry, strategy: TapCoordinateStrategy
    )
        -> GesturePoint?
    {
        guard geometry.app.isValid, geometry.observation.isValid, point.x.isFinite, point.y.isFinite else {
            return nil
        }
        let mapped: GesturePoint
        switch strategy {
        case .legacy:
            return nil
        case .appRelativeObserved, .displayTargetedObserved:
            mapped = GesturePoint(
                x: point.x / geometry.observation.width, y: point.y / geometry.observation.height
            )
        case .displayTargeted:
            return displayTargetedOffset(point: point, geometry: geometry)
        case .appRelative:
            // Only the portrait app frame / transposed landscape observation hypothesis is defined.
            guard abs(geometry.app.width - geometry.observation.height) <= 1,
                  abs(geometry.app.height - geometry.observation.width) <= 1 else { return nil }
            switch geometry.rotation {
            case 1:
                mapped = GesturePoint(
                    x: point.y / geometry.app.width, y: (geometry.app.height - point.x) / geometry.app.height
                )
            case 3:
                // DeviceRotation defines 3 as landscapeRight, the opposite quarter-turn.
                // This mirror is unverified on a Duo device.
                mapped = GesturePoint(
                    x: (geometry.app.width - point.y) / geometry.app.width, y: point.x / geometry.app.height
                )
            default:
                return nil
            }
        }
        let tolerance = 1e-9
        guard mapped.x.isFinite, mapped.y.isFinite,
              mapped.x >= -tolerance, mapped.x <= 1 + tolerance,
              mapped.y >= -tolerance, mapped.y <= 1 + tolerance else { return nil }
        return GesturePoint(x: min(1, max(0, mapped.x)), y: min(1, max(0, mapped.y)))
    }

    private nonisolated static func displayTargetedOffset(
        point: GesturePoint, geometry: GestureCoordinateGeometry
    )
        -> GesturePoint?
    {
        guard geometry.rotation == 0 else {
            return mappedOffset(point: point, geometry: geometry, strategy: .appRelative)
        }
        guard abs(geometry.app.width - geometry.observation.width) <= 1,
              abs(geometry.app.height - geometry.observation.height) <= 1 else { return nil }
        return mappedOffset(point: point, geometry: geometry, strategy: .appRelativeObserved)
    }

    nonisolated static func choose(
        point: GesturePoint, geometry: GestureCoordinateGeometry?, forced: TapCoordinateStrategy? = nil
    )
        -> Self
    {
        func legacy(_ reason: String) -> Self {
            Self(strategy: .legacy, reason: reason, normalized: .zero, offset: point)
        }
        if forced == .legacy { return legacy("forced") }
        guard let geometry else { return legacy("mappingUndefined(noObservation)") }
        let mismatch = hasMultiPanelMismatch(app: geometry.app, screen: geometry.screen)
        guard mismatch || forced != nil else { return legacy("singlePanel") }
        let strategy = forced ?? .appRelative
        guard let normalized = mappedOffset(point: point, geometry: geometry, strategy: strategy) else {
            let rotation = geometry.rotation.map { String($0) } ?? "nil"
            return legacy("mappingUndefined(rotation=\(rotation),geometryOrPoint)")
        }
        return Self(
            strategy: strategy,
            reason: forced == nil ? "multiPanelMismatch" : "forced",
            normalized: normalized,
            offset: nil
        )
    }

    var logFields: String {
        let mapped = strategy == .legacy ? "" : " normalized=(\(normalized.x),\(normalized.y))"
        return "strategy=\(strategy.rawValue) strategyReason=\(reason)\(mapped)"
    }
}

/// Every live coordinate construction and action is behind this device-free seam.
@MainActor
protocol GestureCoordinateProviding {
    associatedtype Coordinate
    func geometry() throws -> GestureCoordinateGeometry?
    func coordinate(selection: GestureCoordinateSelection) throws -> Coordinate
    func tap(_ coordinate: Coordinate, duration: TimeInterval) throws
    func drag(
        _ start: Coordinate, to end: Coordinate, press: TimeInterval, velocity: Double?, hold: TimeInterval
    ) throws
}

@MainActor
struct GestureCoordinateFactory<Provider: GestureCoordinateProviding> {
    let provider: Provider
    let geometry: GestureCoordinateGeometry?

    init(provider: Provider, forced: TapCoordinateStrategy? = nil) throws {
        self.provider = provider
        if forced == .legacy {
            geometry = nil
        } else {
            geometry = try provider.geometry()
        }
    }

    func resolve(
        x: Double, y: Double, forced: TapCoordinateStrategy? = nil
    )
        throws -> (coordinate: Provider.Coordinate, selection: GestureCoordinateSelection)
    {
        let selection = GestureCoordinateSelection.choose(
            point: GesturePoint(x: x, y: y), geometry: geometry, forced: forced
        )
        let coordinate = try provider.coordinate(selection: selection)
        return (coordinate, selection)
    }
}
