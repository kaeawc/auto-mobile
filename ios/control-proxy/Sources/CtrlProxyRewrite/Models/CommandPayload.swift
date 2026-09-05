import Foundation

/// Fields common to every typed command payload (today just the correlation id).
///
/// Refined to `Sendable` (vs the reference's bare protocol): the existential
/// `any CommandPayload` returned by `WebSocketRequest.payload` must be `Sendable`
/// to cross into an isolated command handler. Each concrete payload declares its
/// `CommandPayload` conformance in its own file.
public protocol CommandPayload: Sendable {
    var requestId: String? { get }
}
