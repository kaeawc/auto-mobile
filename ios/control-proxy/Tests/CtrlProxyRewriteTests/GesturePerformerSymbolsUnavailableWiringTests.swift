import Foundation
import XCTest

@testable import CtrlProxyRewrite

/// The bridge-driven gesture paths compile only for iOS, so a macOS test host
/// cannot execute them. Keep this source guard close to the extracted pure
/// tests so the availability signal cannot be silently disconnected. See #3985.
///
/// Mirrors `CtrlProxyTests.GesturePerformerSymbolsUnavailableWiringTests`; reads the
/// rewrite's `Sources/CtrlProxyRewrite/GesturePerformer.swift`. The ported `pinch`/
/// `multiFingerSwipe` keep the same bridge-availability wiring, so the same substring
/// ordering must hold.
final class GesturePerformerSymbolsUnavailableWiringTests: XCTestCase {
    func testPinchRoutesBridgeAvailabilitySignalToFallback() throws {
        let pinch = try gesturePerformerFunction(named: "pinch(")

        let bridgeArgument = try XCTUnwrap(pinch.range(of: "&symbolsUnavailable"))
        let availabilityGuard = try XCTUnwrap(pinch.range(of: "guard symbolsUnavailable.boolValue else"))
        let fallback = try XCTUnwrap(pinch.range(of: "PinchFallback.parameters("))

        XCTAssertLessThan(
            bridgeArgument.lowerBound,
            availabilityGuard.lowerBound,
            "pinch must consume the bridge's symbolsUnavailable out-parameter"
        )
        XCTAssertLessThan(
            availabilityGuard.lowerBound,
            fallback.lowerBound,
            "only unavailable private symbols may route pinch through PinchFallback"
        )
    }

    func testMultiFingerSwipeRoutesBridgeAvailabilitySignalToDiagnostics() throws {
        let multiFingerSwipe = try gesturePerformerFunction(named: "multiFingerSwipe(")

        let bridgeArgument = try XCTUnwrap(multiFingerSwipe.range(of: "&symbolsUnavailable"))
        let diagnosticsArgument = try XCTUnwrap(
            multiFingerSwipe.range(of: "symbolsUnavailable: symbolsUnavailable.boolValue")
        )
        let diagnostics = try XCTUnwrap(
            multiFingerSwipe.range(of: "MultiFingerSwipeDiagnostics.failureMessage(")
        )

        XCTAssertLessThan(
            bridgeArgument.lowerBound,
            diagnosticsArgument.lowerBound,
            "multiFingerSwipe must pass the bridge's symbolsUnavailable out-parameter to diagnostics"
        )
        XCTAssertLessThan(
            diagnostics.lowerBound,
            diagnosticsArgument.lowerBound,
            "symbolsUnavailable must be an argument to MultiFingerSwipeDiagnostics.failureMessage"
        )
    }

    private func gesturePerformerFunction(named name: String) throws -> String {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sourceURL = packageRoot.appendingPathComponent("Sources/CtrlProxyRewrite/GesturePerformer.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let functionStart = try XCTUnwrap(source.range(of: "public func " + name))
        let remainingSource = source[functionStart.upperBound...]
        let nextDeclaration = [
            remainingSource.range(of: "\n        public func ").map(\.lowerBound),
            remainingSource.range(of: "\n        private ").map(\.lowerBound),
        ].compactMap { $0 }.min()
        let functionEnd = nextDeclaration ?? source.endIndex

        return String(source[functionStart.lowerBound..<functionEnd])
    }
}
