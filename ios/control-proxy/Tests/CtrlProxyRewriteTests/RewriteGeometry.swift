@testable import CtrlProxyRewrite
import Foundation

/// Drives the `CtrlProxyRewrite` pure geometry/diagnostics helpers (see
/// `ReferenceGeometry`). `@testable` reaches the internal `DeviceRotation` /
/// `RotationCaptureSample`.
enum RewriteGeometry {
    static func pinchParameters(
        start: Double,
        end: Double,
        duration: TimeInterval
    )
        -> (scale: Double, velocity: Double)
    {
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
    )
        throws -> (x: Double, y: Double)?
    {
        let hierarchy = try JSONDecoder().decode(SdkViewHierarchy.self, from: sdkJSON)
        return SemanticLinkActivation.coordinate(
            in: hierarchy,
            ownerResourceId: owner,
            text: text,
            occurrence: occurrence
        ).map { ($0.coordinate.x, $0.coordinate.y) }
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
