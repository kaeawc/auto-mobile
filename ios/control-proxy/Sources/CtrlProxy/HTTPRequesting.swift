import Foundation

protocol HTTPRequesting: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

struct URLSessionHTTPTransport: HTTPRequesting, @unchecked Sendable {
    let session: URLSession
    var invalidateAfterRequest = false

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        defer { if invalidateAfterRequest { session.finishTasksAndInvalidate() } }
        return try await session.data(for: request)
    }
}
