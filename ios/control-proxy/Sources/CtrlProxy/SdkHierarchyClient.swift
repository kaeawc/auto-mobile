import Foundation

/// HTTP client for fetching view hierarchy on demand from the SDK's in-app server (port 8766).
/// Falls back gracefully when the SDK server isn't available (target app without SDK embedded).
public final class SdkHierarchyClient: SdkHierarchyFetching, @unchecked Sendable {
    private let baseURL: URL
    private let urlSession: URLSession

    public init(port: UInt16 = 8766) {
        // Hardcoded localhost URL with an integer port always parses.
        self.baseURL = URL(string: "http://localhost:\(port)")!  // swiftlint:disable:this force_unwrapping
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 5
        config.waitsForConnectivity = false
        self.urlSession = URLSession(configuration: config)
    }

    /// Fetch the latest cached hierarchy from the SDK (fast, no main-thread work in the target app).
    public func fetchHierarchy() -> SdkViewHierarchy? {
        return fetchSync(path: "/hierarchy")
    }

    /// Request a fresh hierarchy walk from the SDK (slower, involves main-thread work in the target app).
    public func fetchFreshHierarchy() -> SdkViewHierarchy? {
        return fetchSync(path: "/hierarchy/fresh")
    }

    /// Fetch lightweight SDK server metadata without walking or serializing the view tree.
    public func fetchServerInfo() -> SdkHierarchyServerInfo? {
        guard let data = requestSync(path: "/health", session: healthSession) else { return nil }
        return try? JSONDecoder().decode(SdkHierarchyServerInfo.self, from: data)
    }

    /// Whether the SDK hierarchy server is reachable.
    public func isAvailable() -> Bool {
        return fetchServerInfo() != nil
    }

    /// Replace network mock rules in the SDK's in-app server.
    public func setMockRules(_ rules: [NetworkMockRuleDTO]) -> Bool {
        guard let body = try? JSONEncoder().encode(SetMockRulesBody(rules: rules)) else {
            return false
        }
        return postSync(path: "/network/mock", body: body, session: urlSession)
    }

    public func setNetworkFaultRules(_ rules: [NetworkFaultRuleDTO]) -> Bool {
        guard let body = try? JSONEncoder().encode(SetNetworkFaultRulesBody(rules: rules)) else {
            return false
        }
        return postSync(path: "/network/fault-rules", body: body, session: urlSession)
    }

    public func setNetworkErrorSimulation(_ config: NetworkErrorSimulationDTO) -> Bool {
        guard let body = try? JSONEncoder().encode(config) else {
            return false
        }
        return postSync(path: "/network/error-simulation", body: body, session: urlSession)
    }

    /// Draw a highlight in the target app through the SDK's in-app server.
    public func addHighlight(id: String, shape: HighlightShape) -> SdkHighlightOutcome {
        guard let body = try? JSONEncoder().encode(AddHighlightBody(id: id, shape: shape)) else {
            return .unavailable
        }
        return postHighlight(path: "/highlight", body: body, session: urlSession)
    }

    // MARK: - Private

    private lazy var healthSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 0.5
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    private func fetchSync(path: String) -> SdkViewHierarchy? {
        guard let data = requestSync(path: path, session: urlSession) else { return nil }
        return try? JSONDecoder().decode(SdkViewHierarchy.self, from: data)
    }

    private func requestSync(path: String, session: URLSession) -> Data? {
        let url = baseURL.appendingPathComponent(path)
        let semaphore = DispatchSemaphore(value: 0)
        var result: Data?

        session.dataTask(with: url) { data, response, _ in
            defer { semaphore.signal() }
            guard let http = response as? HTTPURLResponse,
                  http.statusCode == 200,
                  let data = data else { return }
            result = data
        }.resume()

        semaphore.wait()
        return result
    }

    /// POST a highlight and classify the result: an HTTP response distinguishes a
    /// deliberate rejection (non-200) from the bridge being unreachable (no response).
    private func postHighlight(path: String, body: Data, session: URLSession) -> SdkHighlightOutcome {
        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let semaphore = DispatchSemaphore(value: 0)
        var outcome: SdkHighlightOutcome = .unavailable

        session.dataTask(with: request) { _, response, _ in
            defer { semaphore.signal() }
            // No HTTP response means the in-app bridge was unreachable.
            guard let http = response as? HTTPURLResponse else { return }
            outcome = http.statusCode == 200 ? .rendered : .rejected
        }.resume()

        semaphore.wait()
        return outcome
    }

    private func postSync(path: String, body: Data, session: URLSession) -> Bool {
        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let semaphore = DispatchSemaphore(value: 0)
        var ok = false

        session.dataTask(with: request) { _, response, _ in
            defer { semaphore.signal() }
            guard let http = response as? HTTPURLResponse else { return }
            ok = http.statusCode == 200
        }.resume()

        semaphore.wait()
        return ok
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
