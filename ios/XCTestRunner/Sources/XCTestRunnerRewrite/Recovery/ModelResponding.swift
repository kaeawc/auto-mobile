import Tachikoma

/// Narrow seam over the Tachikoma model call so the recovery loop can be unit-tested with a fake model
/// (no network, no API key). The production implementation is `TachikomaModelResponder`. Refines
/// `Sendable` so the Sendable handler can hold a `@Sendable` factory producing it.
public protocol ModelResponding: Sendable {
    func respond(_ request: ModelRequest) async throws -> ModelResponse
}
