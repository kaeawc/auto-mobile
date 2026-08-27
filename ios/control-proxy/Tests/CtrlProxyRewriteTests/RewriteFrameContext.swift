@testable import CtrlProxyRewrite
import Foundation

/// Drives the `CtrlProxyRewrite.FrameContext` (see `ReferenceFrameContext`).
/// `@testable` reaches the internal `FrameContext` / `init(epoch:)` / `context(for:)`.
enum RewriteFrameContext {
    static func contextToken(hierarchyJSON: Data, epoch: UUID) throws -> String? {
        let hierarchy = try JSONDecoder().decode(ViewHierarchy.self, from: hierarchyJSON)
        return FrameContext(epoch: epoch).context(for: hierarchy)
    }

    static func recordTransitionTokens(hierarchyJSONs: [Data], epoch: UUID) throws -> [String?] {
        let context = FrameContext(epoch: epoch)
        let decoder = JSONDecoder()
        return try hierarchyJSONs.map { data in
            let hierarchy = try decoder.decode(ViewHierarchy.self, from: data)
            return context.recordTransition(to: hierarchy)
        }
    }
}
