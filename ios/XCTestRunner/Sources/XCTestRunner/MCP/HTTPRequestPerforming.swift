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
    var exchange: @Sendable (URLSession, URLRequest, RefuseDaemonRedirects?) async throws -> (Data, URLResponse) = {
        try await $0.data(for: $1, delegate: $2)
    }

    func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        try Task.checkCancellation()
        return try await exchange(session, request, Self.redirectDelegate(for: request))
    }

    static func redirectDelegate(for request: URLRequest) -> RefuseDaemonRedirects? {
        guard let url = request.url,
              AuthenticatedDaemonHTTPRequestPerformer.isDaemonEndpoint(url)
        else { return nil }
        return RefuseDaemonRedirects()
    }
}

/// Daemon credentials are scoped to the original endpoint, including caller-provided headers.
final class RefuseDaemonRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _: URLSession, task _: URLSessionTask,
        willPerformHTTPRedirection _: HTTPURLResponse,
        newRequest _: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

/// Shared authentication for daemon HTTP requests, including a single token refresh on HTTP 401.
/// Startup 503 replies have a bounded delay/retry budget inside the caller's deadline.
/// A rejected response never installs MCP session state.
struct AuthenticatedDaemonHTTPRequestPerformer: HTTPRequestPerforming {
    let performer: any HTTPRequestPerforming
    let tokenProvider: any DaemonHTTPTokenProviding
    var scheduler: any DeadlineScheduler = SystemDeadlineScheduler()

    func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        guard let url = request.url, Self.isDaemonEndpoint(url),
              request.value(forHTTPHeaderField: "Authorization") == nil
        else { return try await performer.perform(request) }
        var refreshed = false
        var startupRetries = 5
        while true {
            try Task.checkCancellation()
            var authenticated = request
            authenticated.setValue(
                tokenProvider.readToken().map { "Bearer \($0)" }, forHTTPHeaderField: "Authorization"
            )
            let response = try await performer.perform(authenticated)
            let http = response.1 as? HTTPURLResponse
            if http?.statusCode == 503, http?.value(forHTTPHeaderField: "Retry-After") == "1", startupRetries > 0 {
                startupRetries -= 1
                try await scheduler.sleep(seconds: 1)
                continue
            }
            if http?.statusCode != 401 || refreshed { return response }
            refreshed = true
        }
    }

    /// Exact loopback names only, matching the shared daemon HTTP endpoint vectors.
    static func isDaemonEndpoint(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedHost?.lowercased()
        else { return false }
        return ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
    }
}
