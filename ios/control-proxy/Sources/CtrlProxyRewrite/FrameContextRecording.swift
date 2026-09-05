import Foundation

/// Records a hierarchy transition and returns the opaque `frameContext` token that
/// rides on the broadcast hierarchy update. A seam so the server does not depend on
/// the concrete `FrameContext`. `recordTransition` is **synchronous** (the broadcast
/// path never `await`s), which is why the concrete `FrameContext` is lock-confined
/// over its generation counter — not an actor — with the hashing extracted to a
/// stateless per-call function.
protocol FrameContextRecording: Sendable {
    func recordTransition(to hierarchy: ViewHierarchy) -> String?
}
