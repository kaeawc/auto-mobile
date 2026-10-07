import Foundation
import os

/// Async HTTP client for the SDK's in-app hierarchy server. Immutable transports
/// and a shared actor-isolated endpoint resolver keep the client Sendable. Production
/// requests discover and verify the simulator; injected fixed URLs remain testable.
public final class SdkHierarchyClient: SdkHierarchyFetching, Sendable {
    private let baseURL: URL
    private let endpointResolver: SdkEndpointResolver?
    private let transport: any HTTPRequesting
    /// Separate transport for `/health`: the reference used a 0.5s-timeout session so an
    /// availability probe fails fast, distinct from the 2s data session.
    private let healthTransport: any HTTPRequesting

    public convenience init(port: UInt16 = 8766) {
        self.init(port: port, endpointResolver: .production(legacyPort: port))
    }

    convenience init(port: UInt16 = 8766, endpointResolver: SdkEndpointResolver) {
        let baseURL = URL(string: "http://127.0.0.1:\(port)")! // swiftlint:disable:this force_unwrapping

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
            healthTransport: URLSessionHTTPTransport(session: URLSession(configuration: healthConfig)),
            endpointResolver: endpointResolver
        )
    }

    /// Designated initializer over the `HTTPRequesting` seam (tests inject stubs).
    init(
        baseURL: URL,
        transport: any HTTPRequesting,
        healthTransport: any HTTPRequesting,
        endpointResolver: SdkEndpointResolver? = nil
    ) {
        self.baseURL = baseURL
        self.endpointResolver = endpointResolver
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

    /// Replace network mock rules and read back which ones the SDK's regex engine rejected. An SDK that
    /// predates the report answers `{"status":"ok"}` without `rejected`, so the outcome carries no report.
    public func pushMockRules(_ rules: [NetworkMockRuleDTO]) async -> SdkMockRulesOutcome {
        guard let body = try? JSONEncoder().encode(SetMockRulesBody(rules: rules)) else {
            return SdkMockRulesOutcome(ok: false)
        }
        guard let responseBody = await postReturningBody(path: "/network/mock", body: body) else {
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

    public func performMagicTap() async -> Bool? {
        do {
            let (data, response) = try await SdkEndpointResolver.requestData(
                for: jsonPost(path: "/accessibility/magic-tap", body: Data("{}".utf8)),
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
                for: jsonPost(path: "/trigger", body: body), transport: transport, resolver: endpointResolver
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
            let (data, response) = try await SdkEndpointResolver.requestData(
                for: URLRequest(url: url), transport: transport, resolver: endpointResolver
            )
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return data
        } catch let error as SdkEndpointError {
            Self.logEndpointError(error)
            return nil
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

private struct SetMockRulesBody: Encodable {
    let rules: [NetworkMockRuleDTO]
}

/// The SDK's reply to `POST /network/mock`; `rejected` is absent from an SDK that predates issue #10101.
private struct SetMockRulesReply: Decodable {
    struct Rejected: Decodable {
        let mockId: String
        let reason: String
    }

    let rejected: [Rejected]?
}

private struct SetNetworkFaultRulesBody: Encodable {
    let rules: [NetworkFaultRuleDTO]
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
