import Foundation

/// One HTTP exchange; implementations must release suspended requests on Task cancellation so the
/// structured deadline can join its losing child. No MCP decoding or session mutation belongs here.
protocol HTTPRequestPerforming: Sendable {
    func perform(_ request: URLRequest) async throws -> (Data, URLResponse)
}

/// URLSession.data(for:) already owns cancellation and exactly-once completion of its URLSessionTask
/// (cancellation resumes with URLError.cancelled). Hand-rolling dataTask plus a continuation would
/// duplicate Foundation's machinery. The client distinguishes outer cancellation from timeout.
struct URLSessionRequestPerformer: HTTPRequestPerforming {
    let session: URLSession

    func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        try Task.checkCancellation()
        return try await session.data(for: request)
    }
}
