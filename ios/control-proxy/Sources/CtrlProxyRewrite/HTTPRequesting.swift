import Foundation

/// Async HTTP transport seam for the SDK clients. Replaces the reference's hardcoded
/// `URLSession.dataTask(_:) + DispatchSemaphore.wait` blocking bridge with a plain
/// `async` call, and makes the network dependency injectable so client behavior can be
/// unit-tested deterministically (the reference clients could only be exercised against
/// a live socket). Every request — GET or POST — funnels through `data(for:)`.
///
/// `Sendable` so the `Sendable` clients can store it.
protocol HTTPRequesting: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

/// Production transport backed by `URLSession`. `URLSession` is thread-safe per Apple's
/// documentation but is *not* annotated `Sendable` in the SDK, so this adapter is
/// `@unchecked Sendable` — justified by that documented thread-safety; it holds only an
/// immutable session reference.
struct URLSessionHTTPTransport: HTTPRequesting, @unchecked Sendable {
    let session: URLSession

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await session.data(for: request)
    }
}
