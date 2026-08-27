import Foundation

/// Async HTTP client for the SDK's in-app hierarchy server (port 8766). Ported from the
/// reference `SdkHierarchyClient.swift`.
///
/// Rewrite archetype: a **stateless `Sendable`** async client. The reference blocked a
/// `URLSession` completion handler on a `DispatchSemaphore` per call; this replaces that
/// with `await transport.data(for:)` over the injectable `HTTPRequesting` seam. All
/// stored state is immutable (`baseURL` + two transports), so the client is `Sendable`
/// with no isolation. The reference's `healthSession` was a `lazy var` (mutable, so
/// non-`Sendable`); it is now an eagerly-created stored transport — the only behavioral
/// difference is that the 0.5s-timeout session is built at init rather than on first
/// `/health` call, which is not observable on the wire.
public final class SdkHierarchyClient: SdkHierarchyFetching, Sendable {
    private let baseURL: URL
    private let transport: any HTTPRequesting
    /// Separate transport for `/health`: the reference used a 0.5s-timeout session so an
    /// availability probe fails fast, distinct from the 2s data session.
    private let healthTransport: any HTTPRequesting

    public convenience init(port: UInt16 = 8766) {
        // Hardcoded localhost URL with an integer port always parses.
        let baseURL = URL(string: "http://localhost:\(port)")!

        let dataConfig = URLSessionConfiguration.default
        dataConfig.timeoutIntervalForRequest = 2
        dataConfig.timeoutIntervalForResource = 5
        dataConfig.waitsForConnectivity = false

        let healthConfig = URLSessionConfiguration.default
        healthConfig.timeoutIntervalForRequest = 0.5
        healthConfig.waitsForConnectivity = false

        self.init(
            baseURL: baseURL,
            transport: URLSessionHTTPTransport(session: URLSession(configuration: dataConfig)),
            healthTransport: URLSessionHTTPTransport(session: URLSession(configuration: healthConfig))
        )
    }

    /// Designated initializer over the `HTTPRequesting` seam (tests inject stubs).
    init(baseURL: URL, transport: any HTTPRequesting, healthTransport: any HTTPRequesting) {
        self.baseURL = baseURL
        self.transport = transport
        self.healthTransport = healthTransport
    }

    /// Fetch the latest cached hierarchy from the SDK (fast, no main-thread work in the target app).
    public func fetchHierarchy() async -> SdkViewHierarchy? {
        await fetchDecoded(path: "/hierarchy")
    }

    /// Request a fresh hierarchy walk from the SDK (slower, involves main-thread work in the target app).
    public func fetchFreshHierarchy() async -> SdkViewHierarchy? {
        await fetchDecoded(path: "/hierarchy/fresh")
    }

    /// Fetch lightweight SDK server metadata without walking or serializing the view tree.
    public func fetchServerInfo() async -> SdkHierarchyServerInfo? {
        guard let data = await getData(path: "/health", transport: healthTransport) else { return nil }
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
        return await postExpectingOK(path: "/network/mock", body: body)
    }

    public func setNetworkFaultRules(_ rules: [NetworkFaultRuleDTO]) async -> Bool {
        guard let body = try? JSONEncoder().encode(SetNetworkFaultRulesBody(rules: rules)) else {
            return false
        }
        return await postExpectingOK(path: "/network/fault-rules", body: body)
    }

    public func setNetworkErrorSimulation(_ config: NetworkErrorSimulationDTO) async -> Bool {
        guard let body = try? JSONEncoder().encode(config) else {
            return false
        }
        return await postExpectingOK(path: "/network/error-simulation", body: body)
    }

    /// Draw a highlight in the target app through the SDK's in-app server.
    public func addHighlight(id: String, shape: HighlightShape) async -> SdkHighlightOutcome {
        guard let body = try? JSONEncoder().encode(AddHighlightBody(id: id, shape: shape)) else {
            return .unavailable
        }
        return await postHighlight(path: "/highlight", body: body)
    }

    // MARK: - Private

    private func fetchDecoded(path: String) async -> SdkViewHierarchy? {
        guard let data = await getData(path: path, transport: transport) else { return nil }
        return try? JSONDecoder().decode(SdkViewHierarchy.self, from: data)
    }

    /// GET `path`; return the body only on HTTP 200, matching the reference's
    /// `requestSync` (any transport error / non-200 / missing body yields nil).
    private func getData(path: String, transport: any HTTPRequesting) async -> Data? {
        let url = baseURL.appendingPathComponent(path)
        do {
            let (data, response) = try await transport.data(for: URLRequest(url: url))
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return data
        } catch {
            // The reference swallowed every URLSession error to nil (server absent is
            // the common case for a target app without the SDK embedded).
            return nil
        }
    }

    /// POST a highlight and classify the result: an HTTP response distinguishes a
    /// deliberate rejection (non-200) from the bridge being unreachable (no response).
    private func postHighlight(path: String, body: Data) async -> SdkHighlightOutcome {
        do {
            let (_, response) = try await transport.data(for: jsonPost(path: path, body: body))
            // No HTTP response means the in-app bridge was unreachable.
            guard let http = response as? HTTPURLResponse else { return .unavailable }
            return http.statusCode == 200 ? .rendered : .rejected
        } catch {
            return .unavailable
        }
    }

    private func postExpectingOK(path: String, body: Data) async -> Bool {
        do {
            let (_, response) = try await transport.data(for: jsonPost(path: path, body: body))
            guard let http = response as? HTTPURLResponse else { return false }
            return http.statusCode == 200
        } catch {
            return false
        }
    }

    private func jsonPost(path: String, body: Data) -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return request
    }
}

private struct SetMockRulesBody: Encodable {
    let rules: [NetworkMockRuleDTO]
}

private struct SetNetworkFaultRulesBody: Encodable {
    let rules: [NetworkFaultRuleDTO]
}

private struct AddHighlightBody: Encodable {
    let id: String
    let shape: HighlightShape
}
