import CtrlProxy
import Foundation

/// Drives the REFERENCE `CtrlProxy.FrameContext`, returning module-agnostic tokens so
/// the parity test never names either module's `ViewHierarchy`. Imports only
/// `CtrlProxy`; `FrameContext` / `context(for:)` / `recordTransition` are all public
/// there, so `@testable` is not needed.
enum ReferenceFrameContext {
    /// Opaque context token (`epoch:generation:hash`) for a fresh context at generation 0.
    static func contextToken(hierarchyJSON: Data, epoch: UUID) throws -> String? {
        let hierarchy = try JSONDecoder().decode(ViewHierarchy.self, from: hierarchyJSON)
        return FrameContext(epoch: epoch).context(for: hierarchy)
    }

    /// Tokens returned by recording each hierarchy in sequence on ONE context (so the
    /// generation counter advances 1, 2, 3, ...). Runs on the caller's thread; the
    /// parity test calls it on the main thread, so `recordTransition`'s main-thread hop
    /// takes its synchronous fast path.
    static func recordTransitionTokens(hierarchyJSONs: [Data], epoch: UUID) throws -> [String?] {
        let context = FrameContext(epoch: epoch)
        let decoder = JSONDecoder()
        return try hierarchyJSONs.map { data in
            let hierarchy = try decoder.decode(ViewHierarchy.self, from: data)
            return context.recordTransition(to: hierarchy)
        }
    }
}
