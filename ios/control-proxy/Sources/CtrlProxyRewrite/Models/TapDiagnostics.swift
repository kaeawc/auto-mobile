import Foundation

/// Opt-in coordinate resolution and display routing, NOT measured touch delivery. Codable
/// omits nil fields and supports the response encoder's sorted keys. No candidateElement
/// or window enumeration: tap has no cached snapshot, and diagnostic tree queries are not free.
public struct TapDiagnostics: Codable, Sendable, Equatable {
    public struct Point: Codable, Sendable, Equatable {
        public let x: Double
        public let y: Double
    }

    public struct Frame: Codable, Sendable, Equatable {
        public let x: Double
        public let y: Double
        public let width: Double
        public let height: Double
    }

    public struct Requested: Codable, Sendable, Equatable {
        public let x: Double
        public let y: Double
        public let durationMs: Int
        public let mode: String
        public let coordinateConstruction: String
        public let units: String

        /// `mode` defaults to tap/press from the duration; moving gestures name themselves.
        public init(
            x: Double, y: Double, durationMs: Int,
            coordinateConstruction: String = "appFrameOriginPlusPointOffset",
            mode: String? = nil
        ) {
            self.x = x
            self.y = y
            self.durationMs = durationMs
            self.mode = mode ?? (durationMs > 0 ? "press" : "tap")
            self.coordinateConstruction = coordinateConstruction
            units = "points"
        }
    }

    public struct Application: Codable, Sendable, Equatable {
        public var bundleIdentifier: String?
        public var frame: Frame?
        public var windowFrames: [Frame]?
    }

    public struct Screen: Codable, Sendable, Equatable {
        public let bounds: Frame
        public let nativeBounds: Frame
        public let scale: Double
        public let nativeScale: Double
        public let source: String
    }

    public struct OrientationReading: Codable, Sendable, Equatable {
        public let rawValue: Int
        public let value: String
        public let source: String
        public var fallback: String?

        static func device(rawValue: Int) -> Self {
            Self(rawValue: rawValue, value: [
                1: "portrait", 2: "portraitUpsideDown", 3: "landscapeLeft",
                4: "landscapeRight", 5: "faceUp", 6: "faceDown",
            ][rawValue] ?? "unknown", source: "XCUIDevice.shared.orientation")
        }
    }

    public struct Orientation: Codable, Sendable, Equatable {
        public var device: OrientationReading?
        public var interface: OrientationReading?
    }

    public enum Route: String, Codable, Sendable, Equatable {
        case xcuiCoordinate
        case displayTargetedRecord
    }

    public enum DeliveryWarning: String, Codable, Sendable, Equatable {
        case eventDisplayMismatch
    }

    public struct DisplayScreen: Codable, Sendable, Equatable {
        public let displayId: UInt64
        public let isMain: Bool
    }

    public let requested: Requested
    public var baseScreenPoint: Point?
    public var resolvedScreenPoint: Point?
    public var application: Application?
    public var screen: Screen?
    public var orientation: Orientation?
    public var sampleErrors: [String] = []
    public var strategy: String?
    public var strategyReason: String?
    public var normalizedOffset: Point?

    public var route: Route?
    public var targetDisplayId: UInt64?
    public var targetDisplayReason: String?
    public var deviceIdiom: String?
    public var mainDisplayId: UInt64?
    public var applicationDisplayId: UInt64?
    public var screens: [DisplayScreen]?
    public var synthesizedPoint: Point?
    public var synthesizedInterfaceOrientation: Int?
    public var fallbackFrom: String?
    public var deliveryWarning: DeliveryWarning?

    /// Pure, stable formatter, emitted once even for a fast diagnostic tap.
    public func logLine(gesture: String? = nil) -> String {
        func point(_ value: Point?) -> String {
            value.map { "(\($0.x),\($0.y))" } ?? "nil"
        }
        func frame(_ value: Frame?) -> String {
            value.map { "(\($0.x),\($0.y),\($0.width),\($0.height))" } ?? "nil"
        }
        func reading(_ value: OrientationReading?) -> String {
            value
                .map { "\($0.value)(raw=\($0.rawValue),source=\($0.source),fallback=\($0.fallback ?? "none"))" } ??
                "nil"
        }
        // JSON escapes exception reasons so the diagnostic remains one log line.
        let errors = (try? JSONEncoder().encode(sampleErrors)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        let strategyFields = strategy.map { " strategy=\($0) strategyReason=\(strategyReason ?? "nil")" } ?? ""
        let normalizedFields = normalizedOffset.map { " normalized=(\($0.x),\($0.y))" } ?? ""
        let displayFields = route.map {
            " route=\($0.rawValue) targetDisplayId=\(targetDisplayId.map { String($0) } ?? "nil") targetDisplayReason=\(targetDisplayReason ?? "nil") deviceIdiom=\(deviceIdiom ?? "nil") mainDisplayId=\(mainDisplayId.map { String($0) } ?? "nil") applicationDisplayId=\(applicationDisplayId.map { String($0) } ?? "nil")"
        } ?? ""
        let screenFields = screens.flatMap { try? JSONEncoder().encode($0) }
            .flatMap { String(data: $0, encoding: .utf8) }.map { " screens=\($0)" } ?? ""
        let deliveryFields = route.map { _ in
            " synthesizedPoint=\(point(synthesizedPoint)) synthesizedInterfaceOrientation=\(synthesizedInterfaceOrientation.map { String($0) } ?? "nil") fallbackFrom=\(fallbackFrom ?? "nil") deliveryWarning=\(deliveryWarning?.rawValue ?? "nil")"
        } ?? ""
        let gestureFields = gesture.map { " gesture=\($0)" } ?? ""
        return "tap_diagnostics\(gestureFields) requested=(\(requested.x),\(requested.y)) durationMs=\(requested.durationMs) mode=\(requested.mode) base=\(point(baseScreenPoint)) resolved=\(point(resolvedScreenPoint)) appFrame=\(frame(application?.frame)) screenBounds=\(frame(screen?.bounds)) native=\(frame(screen?.nativeBounds)) scale=\(screen.map { String($0.scale) } ?? "nil") nativeScale=\(screen.map { String($0.nativeScale) } ?? "nil") deviceOrientation=\(reading(orientation?.device)) interfaceOrientation=\(reading(orientation?.interface)) sampleErrors=\(errors)\(strategyFields)\(normalizedFields)\(displayFields)\(screenFields)\(deliveryFields)"
    }
}
