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

/// Shared authentication for daemon HTTP requests, including a single token refresh on HTTP 401.
/// The caller's deadline wraps both exchanges. A rejected response never installs MCP session state.
struct AuthenticatedDaemonHTTPRequestPerformer: HTTPRequestPerforming {
    let performer: any HTTPRequestPerforming
    let tokenProvider: any DaemonHTTPTokenProviding

    func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        guard let url = request.url, Self.isDaemonEndpoint(url),
              request.value(forHTTPHeaderField: "Authorization") == nil
        else { return try await performer.perform(request) }
        var refreshed = false
        while true {
            try Task.checkCancellation()
            var authenticated = request
            authenticated.setValue(
                tokenProvider.readToken().map { "Bearer \($0)" }, forHTTPHeaderField: "Authorization"
            )
            let response = try await performer.perform(authenticated)
            if (response.1 as? HTTPURLResponse)?.statusCode != 401 || refreshed { return response }
            refreshed = true
        }
    }

    /// Exact loopback names only, matching the shared daemon HTTP endpoint vectors.
    static func isDaemonEndpoint(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = url.host?.lowercased()
        else { return false }
        return ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
    }
}
