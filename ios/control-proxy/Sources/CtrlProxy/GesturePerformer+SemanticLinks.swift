import Foundation
import ObjCExceptionCatcher
import os
#if os(iOS)
    import UIKit
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

extension GesturePerformer {
    /// A flat XCUITest links query cannot map a per-owner occurrence above zero.
    nonisolated static func validateSemanticLinkFallback(occurrence: Int, ownerResourceId: String?) throws {
        guard ownerResourceId != nil || occurrence <= 0 else {
            throw GestureError.gestureFailed(
                "Semantic link occurrence > 0 needs an owner in the XCUITest fallback; scope with container/subtext."
            )
        }
    }

    /// Includes a scoped owner when the owner is itself a link; XCUITest's
    /// descendants query otherwise excludes that element.
    nonisolated static func scopedLinkCandidates<Element>(
        owner: Element,
        ownerIsLink: Bool,
        descendants: [Element]
    )
        -> [Element]
    {
        ownerIsLink ? [owner] + descendants : descendants
    }
}
