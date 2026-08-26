@testable import CtrlProxy
import Foundation

/// Drives the REFERENCE `CtrlProxy` pure geometry/diagnostics helpers, returning
/// module-agnostic Foundation values. `@testable` reaches the internal
/// `DeviceRotation` / `RotationCaptureSample`; only `CtrlProxy` is imported so the
/// bare type names resolve unambiguously (see `ReferenceWireDecoder`).
enum ReferenceGeometry {
    static func pinchParameters(start: Double, end: Double, duration: TimeInterval) -> (scale: Double, velocity: Double) {
        let p = PinchFallback.parameters(distanceStart: start, distanceEnd: end, duration: duration)
        return (Double(p.scale), Double(p.velocity))
    }

    static func multiFingerFailure(symbolsUnavailable: Bool, underlying: String) -> String {
        MultiFingerSwipeDiagnostics.failureMessage(symbolsUnavailable: symbolsUnavailable, underlying: underlying)
    }

    static func semanticLinkCoordinate(
        sdkJSON: Data,
        owner: String?,
        text: String,
        occurrence: Int
    ) throws -> (x: Double, y: Double)? {
        let hierarchy = try JSONDecoder().decode(SdkViewHierarchy.self, from: sdkJSON)
        guard let c = SemanticLinkActivation.coordinate(
            in: hierarchy,
            ownerResourceId: owner,
            text: text,
            occurrence: occurrence
        ) else { return nil }
        return (c.x, c.y)
    }

    static func rotationFromName(_ name: String) -> Int? {
        DeviceRotation.fromOrientationName(name)
    }

    static func stableRotation(beforeRotation: Int?, beforeGen: UInt64, afterRotation: Int?, afterGen: UInt64) -> Int? {
        RotationCaptureSample.stableRotation(
            between: RotationCaptureSample(rotation: beforeRotation, generation: beforeGen),
            and: RotationCaptureSample(rotation: afterRotation, generation: afterGen)
        )
    }
}
