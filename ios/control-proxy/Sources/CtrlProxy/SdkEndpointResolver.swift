import AutoMobileSdkWire
import Foundation
import os

/// Shared lazy discovery for all SDK clients. The cache is actor-isolated; failed
/// requests invalidate only the endpoint they used, so late failures cannot evict a
/// different endpoint found by another request. GET requests re-resolve once when
/// the app is no longer foreground. Mutations are never automatically retried.
///
/// Compatibility:
/// | runner | SDK app | result |
/// | new | new, simulator(s) | derived port, identity verified, each reaches its own app |
/// | new | new, one simulator | derived port, works |
/// | new | new, two apps one simulator | foreground gate re-resolves |
/// | new | old, fixed 8766 | legacy fallback, identity unknowable, warn once; residual old-SDK risk |
/// | old | new | best-effort 8766, missing header accepted; unchanged if another simulator owns it |
/// | new | new, other simulator on 8766, own app absent | typed wrongSimulator, no data |
/// | any | physical device | fixed port, no identity header or check |
actor SdkEndpointResolver {
    nonisolated let simulatorUdid: String?
    private let healthTransport: any HTTPRequesting
    private let legacyPort: UInt16
    private let now: @Sendable () -> TimeInterval
    private let negativeTTL: TimeInterval
    private let warning: @Sendable (String) -> Void
    private var cachedURL: URL?
    private var negativeUntil: TimeInterval?
    private var lastForegroundBundle: String?
    private var warnedAboutLegacy = false
    /// Bumped by every foreground-bundle or lifecycle change: a discovery that began before one
    /// must not cache its failure for the new app (#14398).
    private var discoveryGeneration = 0
    /// Bumped by a foreground-bundle change; the unavailable warning is reported once per bundle,
    /// independent of the negative-cache TTL (#14399).
    private var bundleGeneration = 0
    private var unavailableReportedBundleGeneration: Int?

    /// Failed discovery costs 7–9 loopback probes. Verify 20261021a observed a 4 s
    /// agent cadence, so the default 30 s negative window covers about seven observes.
    /// Lifecycle and foreground-bundle changes invalidate it immediately; an SDK app
    /// started outside the runner without a bundle change has at most 30 s of staleness.
    init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        healthTransport: any HTTPRequesting,
        legacyPort: UInt16 = 8766,
        now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        negativeTTL: TimeInterval = 30,
        warning: @escaping @Sendable (String) -> Void = {
            Logger(subsystem: "dev.jasonpearson.automobile", category: "SdkEndpointResolver")
                .warning("\($0, privacy: .public)")
        }
    ) {
        simulatorUdid = environment["SIMULATOR_UDID"]
        self.healthTransport = healthTransport
        self.legacyPort = legacyPort
        self.now = now
        self.negativeTTL = negativeTTL
        self.warning = warning
    }

    nonisolated static func production(legacyPort: UInt16 = 8766) -> SdkEndpointResolver {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 0.5
        config.timeoutIntervalForResource = 0.5
        config.waitsForConnectivity = false
        return SdkEndpointResolver(
            healthTransport: URLSessionHTTPTransport(session: URLSession(configuration: config)),
            legacyPort: legacyPort
        )
    }

    func resolve() async throws -> URL {
        guard let udid = simulatorUdid else { return loopbackBaseURL(port: legacyPort) }
        if let cachedURL { return cachedURL }
        let unavailableMessage = "AutoMobile SDK unavailable on simulator \(udid)"
        if let negativeUntil, now() < negativeUntil {
            throw SdkEndpointError.unavailableCached(unavailableMessage)
        }
        let generations = (discovery: discoveryGeneration, bundle: bundleGeneration)
        for attempt in 0 ..< SdkSimulatorPort.probeCount {
            let url = loopbackBaseURL(port: SdkSimulatorPort.simulatorPort(udid: udid, attempt: attempt))
            // A collision, refused connection, or old SDK on a derived port is expected.
            if let info = try? await health(at: url),
               let actual = info.simulatorUdid,
               actual.lowercased() == udid.lowercased()
            {
                cachedURL = url
                negativeUntil = nil
                return url
            }
        }
        let url = loopbackBaseURL(port: legacyPort)
        guard let info = try await health(at: url) else {
            throw unavailable(unavailableMessage, startedAt: generations)
        }
        if let actual = info.simulatorUdid {
            guard actual.lowercased() == udid.lowercased() else {
                throw SdkEndpointError.wrongSimulator(expectedUdid: udid, actualUdid: actual)
            }
        } else if !warnedAboutLegacy {
            warnedAboutLegacy = true
            warning(
                "AutoMobile SDK on legacy port \(legacyPort) has no simulator identity; "
                    + "using legacy behavior. Upgrade the SDK to prevent cross-simulator access."
            )
        }
        cachedURL = url
        negativeUntil = nil
        return url
    }

    /// Caches a failed discovery only while no bundle or lifecycle change happened during its
    /// probes, and reports it as `.unavailable` once for the bundle it was started for.
    private func unavailable(
        _ message: String, startedAt generations: (discovery: Int, bundle: Int)
    )
        -> SdkEndpointError
    {
        if generations.discovery == discoveryGeneration {
            negativeUntil = now() + negativeTTL
        }
        if unavailableReportedBundleGeneration == generations.bundle {
            return .unavailableCached(message)
        }
        unavailableReportedBundleGeneration = generations.bundle
        return .unavailable(message)
    }

    /// A newly foregrounded app may expose an SDK even during a negative window.
    func noteForegroundBundle(_ bundleId: String?) {
        guard bundleId != lastForegroundBundle else { return }
        lastForegroundBundle = bundleId
        negativeUntil = nil
        discoveryGeneration += 1
        bundleGeneration += 1
    }

    /// Runner-managed app lifecycle changes may expose an SDK in the same bundle.
    func noteAppLifecycleEvent() {
        negativeUntil = nil
        discoveryGeneration += 1
    }

    /// One request path supplies the identity header and rejects wrong-simulator
    /// responses before any client can decode data. Transport failure and a background
    /// app clear discovery; only GET requests may retry once at a different endpoint.
    func data(for original: URLRequest, transport: any HTTPRequesting) async throws -> (Data, URLResponse) {
        let endpoint = try await resolve()
        let result = try await data(for: original, endpoint: endpoint, transport: transport)
        guard simulatorUdid != nil,
              SdkEndpointError.isAppNotActive(data: result.0, response: result.1),
              original.httpMethod == nil || original.httpMethod == "GET"
        else { return result }
        let replacement = try await resolve()
        guard replacement != endpoint else { return result }
        return try await data(for: original, endpoint: replacement, transport: transport)
    }

    private func data(
        for original: URLRequest, endpoint: URL, transport: any HTTPRequesting
    )
        async throws -> (Data, URLResponse)
    {
        var request = original
        guard let originalURL = original.url,
              var components = URLComponents(url: originalURL, resolvingAgainstBaseURL: false),
              let origin = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)
        else { throw SdkEndpointError.unavailable("Invalid SDK request URL") }
        components.scheme = origin.scheme
        components.host = origin.host
        components.port = origin.port
        request.url = components.url
        request.setValue(simulatorUdid, forHTTPHeaderField: Self.identityHeader)
        let result: (Data, URLResponse)
        do {
            result = try await transport.data(for: request)
        } catch {
            invalidate(endpoint: endpoint)
            throw error
        }
        if simulatorUdid != nil,
           let error = SdkEndpointError.wrongSimulatorResponse(data: result.0, response: result.1)
        {
            invalidate(endpoint: endpoint)
            throw error
        }
        if simulatorUdid != nil, SdkEndpointError.isAppNotActive(data: result.0, response: result.1) {
            invalidate(endpoint: endpoint)
        }
        return result
    }

    /// A nil resolver retains designated initializer semantics for injected fixed
    /// endpoints. Production convenience initializers always install discovery.
    nonisolated static func requestData(
        for request: URLRequest, transport: any HTTPRequesting, resolver: SdkEndpointResolver?
    )
        async throws -> (Data, URLResponse)
    {
        if let resolver { return try await resolver.data(for: request, transport: transport) }
        let result = try await transport.data(for: request)
        if let error = SdkEndpointError.wrongSimulatorResponse(data: result.0, response: result.1) { throw error }
        return result
    }

    private func invalidate(endpoint: URL) {
        if cachedURL == endpoint { cachedURL = nil }
    }

    private func health(at url: URL) async throws -> SdkHierarchyServerInfo? {
        var request = URLRequest(url: url.appendingPathComponent(SdkRoute.health.path))
        request.setValue(simulatorUdid, forHTTPHeaderField: Self.identityHeader)
        let result: (Data, URLResponse)
        do {
            result = try await healthTransport.data(for: request)
        } catch {
            // Nothing listening is expected during bounded discovery (including app startup).
            return nil
        }
        if let error = SdkEndpointError.wrongSimulatorResponse(data: result.0, response: result.1) { throw error }
        guard let response = result.1 as? HTTPURLResponse, response.statusCode == 200 else { return nil }
        do {
            return try JSONDecoder().decode(SdkHierarchyServerInfo.self, from: result.0)
        } catch {
            warning("SDK health decode failed; treating endpoint as unavailable: \(error)")
            return nil
        }
    }

    nonisolated static let identityHeader = "X-AutoMobile-Simulator-Udid"
}

enum SdkEndpointError: LocalizedError, Sendable {
    case unavailable(String)
    /// Discovery already failed in this window, or was already reported for this foreground
    /// bundle; callers should not repeat its warning.
    case unavailableCached(String)
    case wrongSimulator(expectedUdid: String, actualUdid: String)

    var errorDescription: String? {
        switch self {
        case let .unavailable(message), let .unavailableCached(message):
            return message
        case let .wrongSimulator(expected, actual):
            return Self.wrongSimulatorMessage(expectedUdid: expected, actualUdid: actual)
        }
    }

    static func wrongSimulatorMessage(expectedUdid: String, actualUdid: String) -> String {
        "AutoMobile SDK answered from simulator \(actualUdid), but simulator \(expectedUdid) was requested; "
            + "the SDK app on this simulator is not reachable. Launch it and retry."
    }

    static func wrongSimulatorResponse(data: Data, response: URLResponse) -> SdkEndpointError? {
        guard let http = response as? HTTPURLResponse, http.statusCode == 409,
              let payload = try? JSONDecoder().decode(WrongSimulatorPayload.self, from: data),
              payload.error == "wrong_simulator" else { return nil }
        // The server's expected identity is the answering app; actual is the request header.
        return .wrongSimulator(expectedUdid: payload.actualUdid, actualUdid: payload.expectedUdid)
    }

    static func isAppNotActive(data: Data, response: URLResponse) -> Bool {
        guard let http = response as? HTTPURLResponse, http.statusCode == 409,
              let payload = try? JSONDecoder().decode(AppNotActivePayload.self, from: data)
        else { return false }
        return payload.error == "app_not_active"
    }
}

private struct AppNotActivePayload: Decodable {
    let error: String
}

private struct WrongSimulatorPayload: Decodable {
    let error: String
    let expectedUdid: String
    let actualUdid: String
}

/// The SDK clients and endpoint discovery use the same IPv4 loopback origin.
func loopbackBaseURL(port: UInt16) -> URL {
    guard let url = URL(string: "http://127.0.0.1:\(port)") else {
        preconditionFailure("invalid loopback port \(port)")
    }
    return url
}
