import Foundation

/// Records a hierarchy transition and returns the opaque `frameContext` token that
/// rides on the broadcast hierarchy update. A seam so the server does not depend on
/// the concrete `FrameContext` (ported later, where it becomes an actor over its
/// generation counter with the hashing extracted to a stateless function).
protocol FrameContextRecording: Sendable {
    func recordTransition(to hierarchy: ViewHierarchy) -> String?
}
