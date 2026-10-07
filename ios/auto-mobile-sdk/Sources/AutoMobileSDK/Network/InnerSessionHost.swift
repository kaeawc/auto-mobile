import Foundation
import os

/// Owns the single long-lived `URLSession` that ``AutoMobileURLProtocol`` replays requests on, and
/// routes that session's delegate callbacks to the protocol instance that owns each task.
///
/// A `URLProtocol` cannot see the configuration of the app's session, so the inner session mirrors
/// what is knowable: `URLSessionConfiguration.default`, whose cookie, credential and URL-cache
/// storage are the process-wide shared ones, and per-request settings (`httpShouldHandleCookies`,
/// `cachePolicy`, timeouts, network-access flags), which travel on the copied request. One session
/// means one connection pool, so connections (and HTTP/2 streams) are reused across requests.
///
/// The session is never invalidated: each task's owner is held only until that task completes
/// (a cancelled task still completes), so nothing accumulates and nothing is torn down mid-request.
final class InnerSessionHost: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private struct State {
        var session: URLSession?
        var owners: [Int: AutoMobileURLProtocol] = [:]
        var configurationsBuilt = 0
    }

    private let makeConfiguration: @Sendable () -> URLSessionConfiguration
    private let state = OSAllocatedUnfairLock(initialState: State())

    init(
        makeConfiguration: @escaping @Sendable ()
            -> URLSessionConfiguration = { InnerSessionHost.mirroredConfiguration() }
    ) {
        self.makeConfiguration = makeConfiguration
        super.init()
    }

    /// Shared cookie, credential and cache storage, minus this protocol so replays never recurse.
    static func mirroredConfiguration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.default
        config.protocolClasses = config.protocolClasses?.filter { $0 != AutoMobileURLProtocol.self }
        return config
    }

    /// How many sessions this host has built; stays at most 1 for the host's lifetime.
    var sessionsBuilt: Int { state.withLock { $0.configurationsBuilt } }

    /// Number of in-flight tasks still routed to a protocol instance.
    var inFlightTaskCount: Int { state.withLock { $0.owners.count } }

    /// The long-lived session, created on first use.
    var session: URLSession {
        state.withLock { state in sessionLocked(&state) }
    }

    /// Creates a suspended task for `request` and routes its callbacks to `owner`.
    func makeTask(for request: URLRequest, owner: AutoMobileURLProtocol) -> URLSessionDataTask {
        state.withLock { state in
            let task = sessionLocked(&state).dataTask(with: request)
            state.owners[task.taskIdentifier] = owner
            return task
        }
    }

    private func sessionLocked(_ state: inout State) -> URLSession {
        if let session = state.session { return session }
        let session = URLSession(configuration: makeConfiguration(), delegate: self, delegateQueue: nil)
        state.session = session
        state.configurationsBuilt += 1
        return session
    }

    private func owner(for task: URLSessionTask) -> AutoMobileURLProtocol? {
        state.withLock { $0.owners[task.taskIdentifier] }
    }

    private func releaseOwner(for task: URLSessionTask) -> AutoMobileURLProtocol? {
        state.withLock { $0.owners.removeValue(forKey: task.taskIdentifier) }
    }

    // MARK: - URLSessionDataDelegate

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let owner = owner(for: dataTask) else {
            completionHandler(.cancel)
            return
        }
        owner.urlSession(session, dataTask: dataTask, didReceive: response, completionHandler: completionHandler)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        owner(for: dataTask)?.urlSession(session, dataTask: dataTask, didReceive: data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        releaseOwner(for: task)?.urlSession(session, task: task, didCompleteWithError: error)
    }

    // Redirects: no `willPerformHTTPRedirection` here on purpose, so the inner session follows
    // redirects itself and only the final response reaches the app; the app's redirect delegate is
    // not consulted. Forwarding redirects to the URL loading system raced: the inner 302 could
    // finish the load before the app's delegate decided, and a follow then trapped
    // `URLSession.data(for:)` with neither a response nor an error. Redirect-delegate forwarding
    // is deferred to #10139.

    func urlSession(
        _: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard let owner = owner(for: task) else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        owner.forwardChallenge(challenge, completionHandler: completionHandler)
    }
}

/// Decides which requests the protocol must leave to the app's own networking stack.
///
/// Declined (never captured, never mishandled):
/// - `URLSessionUploadTask` (upload from data, file or stream): the URL loading system reports
///   upload progress (`didSendBodyData`) and replays streamed bodies (`needNewBodyStream`) itself;
///   a `URLProtocol` has no client callback for either.
/// - `URLSessionWebSocketTask` and `URLSessionStreamTask`: a protocol relays one request/response
///   and cannot carry a switched-protocol, bidirectional connection.
/// - Any request with an `Upgrade` header: same reason, for tasks that reach the protocol as plain
///   HTTP requests.
///
/// Background sessions (`URLSessionConfiguration.background`) never consult `protocolClasses`, so
/// there is nothing to decline. Not preserved and not detectable from a request or task: per-session
/// delegate configuration the protocol never sees (the app's own cookie storage, credential storage,
/// URL cache, proxy, TLS settings, `waitsForConnectivity`, resource timeout), task metrics
/// (`didFinishCollecting`), `taskIsWaitingForConnectivity`, and download resume data.
enum InnerSessionPolicy {
    static func shouldDecline(request: URLRequest) -> Bool {
        request.value(forHTTPHeaderField: "Upgrade") != nil
    }

    static func shouldDecline(task: URLSessionTask) -> Bool {
        task is URLSessionUploadTask || task is URLSessionWebSocketTask || task is URLSessionStreamTask
    }
}

/// Completes an inner-session authentication challenge with the answer the app gave through the
/// URL loading system. The first resolution wins; later ones are ignored.
final class InnerChallengeSender: NSObject, URLAuthenticationChallengeSender, @unchecked Sendable {
    typealias Completion = (URLSession.AuthChallengeDisposition, URLCredential?) -> Void

    private let completion: OSAllocatedUnfairLock<Completion?>

    init(_ completion: @escaping Completion) {
        self.completion = OSAllocatedUnfairLock<Completion?>(initialState: completion)
        super.init()
    }

    func resolveIfPending(_ disposition: URLSession.AuthChallengeDisposition, _ credential: URLCredential?) {
        let pending = completion.withLock { handler -> Completion? in
            defer { handler = nil }
            return handler
        }
        pending?(disposition, credential)
    }

    func use(_ credential: URLCredential, for _: URLAuthenticationChallenge) {
        resolveIfPending(.useCredential, credential)
    }

    func continueWithoutCredential(for challenge: URLAuthenticationChallenge) {
        // `.useCredential` with nil is not default trust evaluation, so server-trust challenges
        // take the documented default path instead.
        let isServerTrust = challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust
        resolveIfPending(isServerTrust ? .performDefaultHandling : .useCredential, nil)
    }

    func cancel(_: URLAuthenticationChallenge) {
        resolveIfPending(.cancelAuthenticationChallenge, nil)
    }

    func performDefaultHandling(for _: URLAuthenticationChallenge) {
        resolveIfPending(.performDefaultHandling, nil)
    }

    func rejectProtectionSpaceAndContinue(with _: URLAuthenticationChallenge) {
        resolveIfPending(.rejectProtectionSpace, nil)
    }
}
