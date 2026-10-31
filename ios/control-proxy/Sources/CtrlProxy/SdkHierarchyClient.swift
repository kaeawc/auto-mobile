import AutoMobileSdkWire
import Foundation
import os

/// Async HTTP client for the SDK's in-app hierarchy server. Immutable transports
/// and a shared actor-isolated endpoint resolver keep the client Sendable. Production
/// requests discover and verify the simulator; injected fixed URLs remain testable.
public final class SdkHierarchyClient: SdkHierarchyFetching, Sendable {
    private let baseURL: URL
    private let endpointResolver: SdkEndpointResolver?
    private let transport: any HTTPRequesting
    private let healthTransport: any HTTPRequesting
    private let actionTransport: @Sendable (URLSessionConfiguration) -> any HTTPRequesting

    public convenience init(port: UInt16 = 8766) {
        self.init(port: port, endpointResolver: .production(legacyPort: port))
    }

    convenience init(port: UInt16 = 8766, endpointResolver: SdkEndpointResolver) {
        let baseURL = loopbackBaseURL(port: port)

        let dataConfig = Self.dataConfiguration()

        let healthConfig = URLSessionConfiguration.default
        healthConfig.timeoutIntervalForRequest = 0.5
        healthConfig.waitsForConnectivity = false

        self.init(
            baseURL: baseURL,
            transport: URLSessionHTTPTransport(session: URLSession(configuration: dataConfig)),
            healthTransport: URLSessionHTTPTransport(session: URLSession(configuration: healthConfig)),
            endpointResolver: endpointResolver
        )
    }

    /// Designated initializer over the `HTTPRequesting` seam (tests inject stubs).
    init(
        baseURL: URL,
        transport: any HTTPRequesting,
        healthTransport: any HTTPRequesting,
        endpointResolver: SdkEndpointResolver? = nil,
        actionTransport: @escaping @Sendable (URLSessionConfiguration) -> any HTTPRequesting = {
            URLSessionHTTPTransport(session: URLSession(configuration: $0), invalidateAfterRequest: true)
        }
    ) {
        self.baseURL = baseURL
        self.endpointResolver = endpointResolver
        self.transport = transport
        self.healthTransport = healthTransport
        self.actionTransport = actionTransport
    }

    public func foregroundBundleDidChange(_ bundleId: String?) async {
        await endpointResolver?.noteForegroundBundle(bundleId)
    }

    public func appLifecycleDidChange() async {
        await endpointResolver?.noteAppLifecycleEvent()
    }

    /// Fetch the latest cached hierarchy from the SDK (fast, no main-thread work in the target app).
    public func fetchHierarchy() async -> SdkViewHierarchy? {
        await optionalHierarchy(path: SdkRoute.cachedHierarchy.path)
    }

    /// Request a fresh hierarchy walk from the SDK (slower, involves main-thread work in the target app).
    public func fetchFreshHierarchy() async -> SdkViewHierarchy? {
        await optionalHierarchy(path: SdkRoute.freshHierarchy.path)
    }

    /// Callers of the typed result log failures with their own continuation context.
    public func fetchFreshHierarchyResult() async -> SdkHierarchyFetchResult {
        await fetchDecoded(path: SdkRoute.freshHierarchy.path)
    }

    /// Fetch lightweight SDK server metadata without walking or serializing the view tree.
    public func fetchServerInfo() async -> SdkHierarchyServerInfo? {
        guard let data = await getData(path: SdkRoute.health.path, transport: healthTransport) else { return nil }
        return try? JSONDecoder().decode(SdkHierarchyServerInfo.self, from: data)
    }

    /// Whether the SDK hierarchy server is reachable.
    public func isAvailable() async -> Bool {
        await fetchServerInfo() != nil
    }

    /// Replace network mock rules in the SDK's in-app server.
    public func setMockRules(_ rules: [NetworkMockRuleDTO]) async -> Bool {
        guard let body = try? JSONEncoder().encode(SetMockRulesBody(rules: rules)) else {
            return false
        }
        return await postExpectingOK(path: SdkRoute.networkMock.path, body: body)
    }

    /// Replace network mock rules and read back which ones the SDK's regex engine rejected. An SDK that
    /// predates the report answers `{"status":"ok"}` without `rejected`, so the outcome carries no report.
    public func pushMockRules(_ rules: [NetworkMockRuleDTO]) async -> SdkMockRulesOutcome {
        guard let body = try? JSONEncoder().encode(SetMockRulesBody(rules: rules)) else {
            return SdkMockRulesOutcome(ok: false)
        }
        guard let responseBody = await postReturningBody(path: SdkRoute.networkMock.path, body: body) else {
            return SdkMockRulesOutcome(ok: false)
        }
        guard let reply = try? JSONDecoder().decode(SetMockRulesReply.self, from: responseBody),
              let rejected = reply.rejected
        else {
            return SdkMockRulesOutcome(ok: true)
        }
        return SdkMockRulesOutcome(
            ok: true,
            rejectedMockIds: rejected.map(\.mockId),
            rejectedReasons: Dictionary(rejected.map { ($0.mockId, $0.reason) }) { first, _ in first }
        )
    }

    public func setNetworkFaultRules(_ rules: [NetworkFaultRuleDTO]) async -> Bool {
        guard let body = try? JSONEncoder().encode(SetNetworkFaultRulesBody(rules: rules)) else {
            return false
        }
        return await postExpectingOK(path: SdkRoute.networkFaultRules.path, body: body)
    }

    public func setNetworkErrorSimulation(_ config: NetworkErrorSimulationDTO) async -> Bool {
        guard let body = try? JSONEncoder().encode(config) else {
            return false
        }
        return await postExpectingOK(path: SdkRoute.networkErrorSimulation.path, body: body)
    }

    /// Draw a highlight in the target app through the SDK's in-app server.
    public func addHighlight(id: String, shape: HighlightShape) async -> SdkHighlightOutcome {
        guard let body = try? JSONEncoder().encode(AddHighlightBody(id: id, shape: shape)) else {
            return .unavailable
        }
        return await postHighlight(path: SdkRoute.highlight.path, body: body)
    }

    public func performMagicTap() async -> Bool? {
        do {
            let (data, response) = try await SdkEndpointResolver.requestData(
                for: jsonPost(path: SdkRoute.magicTap.path, body: Data("{}".utf8)),
                transport: transport, resolver: endpointResolver
            )
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return try JSONDecoder().decode(MagicTapPayload.self, from: data).handled
        } catch let error as SdkEndpointError {
            Self.logEndpointError(error)
            return nil
        } catch {
            Logger(subsystem: "dev.jasonpearson.automobile", category: "SdkHierarchyClient")
                .debug("Magic Tap bridge unavailable: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Deliver a host trigger to the SDK's `POST /trigger` route (#1580). Any HTTP reply,
    /// including a structured 4xx, is returned; nil means the bridge was unreachable.
    public func sendTrigger(_ body: Data) async -> SdkTriggerReply? {
        do {
            let (data, response) = try await SdkEndpointResolver.requestData(
                for: jsonPost(path: SdkRoute.trigger.path, body: body), transport: transport, resolver: endpointResolver
            )
            guard let http = response as? HTTPURLResponse else { return nil }
            let payload = try? JSONDecoder().decode(SdkTriggerReplyPayload.self, from: data)
            return SdkTriggerReply(
                statusCode: http.statusCode,
                error: payload?.error,
                reason: payload?.reason,
                registeredModules: payload?.registeredModules,
                supportedTriggers: payload?.supportedTriggers
            )
        } catch let error as SdkEndpointError {
            Self.logEndpointError(error)
            return nil
        } catch {
            Logger(subsystem: "dev.jasonpearson.automobile", category: "SdkHierarchyClient")
                .debug("SDK trigger bridge unavailable: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// POST to an observation-bridge route (#5159). Any HTTP reply is returned with its body;
    /// failures distinguish proven non-delivery from an unanswered request.
    public func sendObservationRequest(
        _ route: SdkRoute,
        body: Data,
        timeoutMs: Double? = nil
    )
        async -> SdkBridgeRequestResult
    {
        var request = jsonPost(path: route.path, body: body)
        var requestTransport = transport
        if let timeoutMs, timeoutMs.isFinite, timeoutMs > 0 {
            let configuration = Self.dataConfiguration(timeoutMs: timeoutMs)
            request.timeoutInterval = configuration.timeoutIntervalForRequest
            requestTransport = actionTransport(configuration)
        }
        let trackedTransport = ObservationRequestTransport(transport: requestTransport)
        do {
            let (data, response) = try await SdkEndpointResolver.requestData(
                for: request, transport: trackedTransport, resolver: endpointResolver
            )
            guard let http = response as? HTTPURLResponse else { return .noReply }
            return .reply(SdkBridgeReply(statusCode: http.statusCode, body: data))
        } catch let error as SdkEndpointError {
            Self.logEndpointError(error)
            let started = await trackedTransport.started
            return started ? .noReply : .notSent
        } catch {
            Logger(subsystem: "dev.jasonpearson.automobile", category: "SdkHierarchyClient")
                .debug("SDK observation bridge unavailable: \(error.localizedDescription, privacy: .public)")
            if let urlError = error as? URLError {
                switch urlError.code {
                case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .notConnectedToInternet:
                    return .notSent
                default: break
                }
            }
            return .noReply
        }
    }

    /// Endpoint identity errors can occur both during discovery and after the POST replies.
    private actor ObservationRequestTransport: HTTPRequesting {
        let transport: any HTTPRequesting
        private(set) var started = false

        init(transport: any HTTPRequesting) {
            self.transport = transport
        }

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            started = true
            return try await transport.data(for: request)
        }
    }

    // MARK: - Private

    /// Action sessions must cover execution plus post-action capture; other reads retain their defaults.
    static func dataConfiguration(timeoutMs: Double? = nil) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.default
        let seconds = timeoutMs.flatMap { $0.isFinite && $0 > 0 ? $0 / 1000 : nil }
        configuration.timeoutIntervalForRequest = seconds ?? 2
        configuration.timeoutIntervalForResource = seconds ?? 5
        configuration.waitsForConnectivity = false
        return configuration
    }

    private func optionalHierarchy(path: String) async -> SdkViewHierarchy? {
        switch await fetchDecoded(path: path) {
        case let .hierarchy(hierarchy): return hierarchy
        case .unavailable: return nil
        case let .failed(failure):
            Logger(subsystem: "dev.jasonpearson.automobile", category: "SdkHierarchyClient")
                .warning("SDK hierarchy fetch failed: \(failure.reason, privacy: .public)")
            return nil
        }
    }

    private func fetchDecoded(path: String) async -> SdkHierarchyFetchResult {
        let data: Data
        do {
            let (body, response) = try await SdkEndpointResolver.requestData(
                for: URLRequest(url: baseURL.appendingPathComponent(path)),
                transport: transport, resolver: endpointResolver
            )
            guard let http = response as? HTTPURLResponse else { return .unavailable }
            guard http.statusCode == 200 else { return .failed(.httpStatus(http.statusCode)) }
            data = body
        } catch let error as URLError where error.code == .timedOut {
            return .failed(.timedOut)
        } catch let error as SdkEndpointError {
            Self.logEndpointError(error)
            return .unavailable
        } catch {
            // Apps without the SDK commonly refuse the connection.
            return .unavailable
        }
        do {
            return try .hierarchy(JSONDecoder().decode(SdkViewHierarchy.self, from: data))
        } catch {
            // DecodingError's description includes its case, coding path and missing key.
            return .failed(.undecodable(reason: String(describing: error)))
        }
    }

    private func getData(path: String, transport: any HTTPRequesting) async -> Data? {
        let url = baseURL.appendingPathComponent(path)
        do {
            let (data, response) = try await SdkEndpointResolver.requestData(
                for: URLRequest(url: url), transport: transport, resolver: endpointResolver
            )
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return data
        } catch let error as SdkEndpointError {
            Self.logEndpointError(error)
            return nil
        } catch {
            return nil
        }
    }

    /// POST a highlight and classify the result: an HTTP response distinguishes a
    /// deliberate rejection (non-200) from the bridge being unreachable (no response).
    private func postHighlight(path: String, body: Data) async -> SdkHighlightOutcome {
        do {
            let (_, response) = try await SdkEndpointResolver.requestData(
                for: jsonPost(path: path, body: body), transport: transport, resolver: endpointResolver
            )
            // No HTTP response means the in-app bridge was unreachable.
            guard let http = response as? HTTPURLResponse else { return .unavailable }
            return http.statusCode == 200 ? .rendered : .rejected
        } catch let error as SdkEndpointError {
            Self.logEndpointError(error)
            return .unavailable
        } catch {
            return .unavailable
        }
    }

    private func postExpectingOK(path: String, body: Data) async -> Bool {
        do {
            let (_, response) = try await SdkEndpointResolver.requestData(
                for: jsonPost(path: path, body: body), transport: transport, resolver: endpointResolver
            )
            guard let http = response as? HTTPURLResponse else { return false }
            return http.statusCode == 200
        } catch let error as SdkEndpointError {
            Self.logEndpointError(error)
            return false
        } catch {
            return false
        }
    }

    /// POST `body`; return the response body only on HTTP 200 (nil for any transport error or other status).
    private func postReturningBody(path: String, body: Data) async -> Data? {
        do {
            let (data, response) = try await SdkEndpointResolver.requestData(
                for: jsonPost(path: path, body: body), transport: transport, resolver: endpointResolver
            )
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return data
        } catch let error as SdkEndpointError {
            Self.logEndpointError(error)
            return nil
        } catch {
            return nil
        }
    }

    private static func logEndpointError(_ error: SdkEndpointError) {
        if case .unavailableCached = error { return }
        Logger(subsystem: "dev.jasonpearson.automobile", category: "SdkHierarchyClient")
            .warning("\(error.localizedDescription, privacy: .public)")
    }

    private func jsonPost(path: String, body: Data) -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return request
    }
}

private struct AddHighlightBody: Encodable {
    let id: String
    let shape: HighlightShape
}

private struct SdkTriggerReplyPayload: Decodable {
    let error: String?
    let reason: String?
    let registeredModules: [String]?
    let supportedTriggers: [String]?
}

private struct MagicTapPayload: Decodable {
    let handled: Bool
}
