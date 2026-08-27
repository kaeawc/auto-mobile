import Foundation
import XCTest

/// Differential parity for `FrameContext` (rewrite Phase 4B). The reference guarded a
/// `var generation` with an `NSLock` on a non-`Sendable` class and shared one
/// `JSONEncoder`; the rewrite is lock-confined (`OSAllocatedUnfairLock<UInt64>`,
/// genuinely `Sendable`) with a fresh per-call encoder. The opaque `frameContext`
/// token rides on broadcast hierarchy updates, so the two implementations must produce
/// byte-identical tokens. Verified through both modules with a FIXED epoch so the
/// `epoch:generation:hash` tokens are directly comparable:
///
///   - `context(for:)` agrees for a rich hierarchy,
///   - `updatedAt` is excluded from the semantic hash (same token despite a different
///     timestamp) — the reason the type exists,
///   - a genuine semantic change (packageName) changes the token identically in both,
///   - `recordTransition` advances the generation 1, 2, 3 identically (even for an
///     unchanged hierarchy), matching across modules.
final class FrameContextParityTests: XCTestCase {
    private let epoch = UUID(uuidString: "00000000-0000-0000-0000-0000000000AB")!

    /// Rich, valid `ViewHierarchy` JSON exercising the semantic fields the hash covers,
    /// parameterized by `updatedAt` (excluded from the hash) and `packageName` (included).
    private func hierarchyJSON(updatedAt: Int64, packageName: String) -> Data {
        let json = """
        {
          "updatedAt": \(updatedAt),
          "packageName": "\(packageName)",
          "hierarchy": {
            "className": "Window",
            "content-desc": "root container",
            "resource-id": "root_id",
            "clickable": "true",
            "enabled": "true",
            "role": "group",
            "bounds": { "left": 0, "top": 0, "right": 393, "bottom": 852 },
            "node": [
              {
                "className": "Button",
                "text": "OK",
                "resource-id": "ok_button",
                "clickable": "true",
                "bounds": { "left": 10, "top": 20, "right": 120, "bottom": 64 }
              }
            ]
          },
          "windowInfo": { "id": 1, "type": 0, "isActive": true, "isFocused": false,
                          "bounds": { "left": 0, "top": 0, "right": 393, "bottom": 852 } },
          "windows": [
            { "id": 1, "type": 0, "isActive": true, "isFocused": true,
              "bounds": { "left": 0, "top": 0, "right": 393, "bottom": 852 } }
          ],
          "screenScale": 3.0,
          "screenWidth": 393,
          "screenHeight": 852,
          "systemInsets": { "top": 59, "right": 0, "bottom": 34, "left": 0 },
          "insets": {
            "available": true,
            "source": "safeAreaInsets",
            "units": "points",
            "safeArea": { "top": 59, "right": 0, "bottom": 34, "left": 0 },
            "systemChrome": {
              "visibility": "visible",
              "statusBar": "shown",
              "homeIndicatorAutoHideRequested": false,
              "source": "scene"
            }
          },
          "fallbackToSpringboard": false
        }
        """
        return Data(json.utf8)
    }

    func testContextTokenMatchesAcrossModules() throws {
        let data = hierarchyJSON(updatedAt: 1_730_000_000_000, packageName: "com.example.app")
        let reference = try ReferenceFrameContext.contextToken(hierarchyJSON: data, epoch: epoch)
        let rewrite = try RewriteFrameContext.contextToken(hierarchyJSON: data, epoch: epoch)

        XCTAssertNotNil(reference)
        XCTAssertEqual(reference, rewrite, "context(for:) token diverged between reference and rewrite")
        // Sanity: token is `epoch:generation:hash`, generation 0 for a fresh context.
        XCTAssertEqual(rewrite?.hasPrefix("\(epoch.uuidString):0:"), true, "unexpected token format: \(rewrite ?? "nil")")
    }

    func testUpdatedAtExcludedFromTokenInBothModules() throws {
        let early = hierarchyJSON(updatedAt: 1_000, packageName: "com.example.app")
        let late = hierarchyJSON(updatedAt: 9_999_999, packageName: "com.example.app")

        let refEarly = try ReferenceFrameContext.contextToken(hierarchyJSON: early, epoch: epoch)
        let refLate = try ReferenceFrameContext.contextToken(hierarchyJSON: late, epoch: epoch)
        let rwEarly = try RewriteFrameContext.contextToken(hierarchyJSON: early, epoch: epoch)
        let rwLate = try RewriteFrameContext.contextToken(hierarchyJSON: late, epoch: epoch)

        XCTAssertEqual(refEarly, refLate, "reference token must ignore updatedAt")
        XCTAssertEqual(rwEarly, rwLate, "rewrite token must ignore updatedAt")
        XCTAssertEqual(refEarly, rwEarly, "reference and rewrite must agree")
    }

    func testSemanticFieldChangesTokenIdenticallyInBothModules() throws {
        let base = hierarchyJSON(updatedAt: 1_730_000_000_000, packageName: "com.example.app")
        let changed = hierarchyJSON(updatedAt: 1_730_000_000_000, packageName: "com.example.other")

        let refBase = try ReferenceFrameContext.contextToken(hierarchyJSON: base, epoch: epoch)
        let refChanged = try ReferenceFrameContext.contextToken(hierarchyJSON: changed, epoch: epoch)
        let rwBase = try RewriteFrameContext.contextToken(hierarchyJSON: base, epoch: epoch)
        let rwChanged = try RewriteFrameContext.contextToken(hierarchyJSON: changed, epoch: epoch)

        XCTAssertNotEqual(refBase, refChanged, "a semantic change must change the reference token")
        XCTAssertNotEqual(rwBase, rwChanged, "a semantic change must change the rewrite token")
        XCTAssertEqual(refChanged, rwChanged, "reference and rewrite must agree on the changed token")
    }

    func testRecordTransitionGenerationSequenceMatchesAcrossModules() throws {
        // Same hierarchy three times: the semantic hash is stable, but the generation
        // must still advance 1, 2, 3 — the token distinguishes re-observations.
        let data = hierarchyJSON(updatedAt: 1_730_000_000_000, packageName: "com.example.app")
        let sequence = [data, data, data]

        let referenceTokens = try ReferenceFrameContext.recordTransitionTokens(hierarchyJSONs: sequence, epoch: epoch)
        let rewriteTokens = try RewriteFrameContext.recordTransitionTokens(hierarchyJSONs: sequence, epoch: epoch)

        XCTAssertEqual(referenceTokens, rewriteTokens, "recordTransition token sequence diverged")
        // Generations advance across an unchanged hierarchy.
        XCTAssertEqual(rewriteTokens[0]?.hasPrefix("\(epoch.uuidString):1:"), true)
        XCTAssertEqual(rewriteTokens[1]?.hasPrefix("\(epoch.uuidString):2:"), true)
        XCTAssertEqual(rewriteTokens[2]?.hasPrefix("\(epoch.uuidString):3:"), true)
    }
}
