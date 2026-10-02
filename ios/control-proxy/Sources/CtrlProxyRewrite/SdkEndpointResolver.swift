import Foundation
import os

/// Shared lazy discovery for all SDK clients. The cache is actor-isolated; failed
/// requests invalidate only the endpoint they used, so late failures cannot evict a
/// different endpoint found by another request. Mutations are never automatically retried.
///
/// Compatibility:
/// | runner | SDK app | result |
/// | new | new, simulator(s) | derived port, identity verified, each reaches its own app |
/// | new | new, one simulator | derived port, works |
/// | new | old, fixed 8766 | legacy fallback, identity unknowable, warn once; residual old-SDK risk |
/// | old | new | best-effort 8766, missing header accepted; unchanged if another simulator owns it |
/// | new | new, other simulator on 8766, own app absent | typed wrongSimulator, no data |
/// | any | physical device | fixed port, no identity header or check |
actor SdkEndpointResolver {
    nonisolated let simulatorUdid: String?
    private let healthTransport: any HTTPRequesting
    private let legacyPort: UInt16
    private let warning: @Sendable (String) -> Void
    private var cachedURL: URL?
    private var warnedAboutLegacy = false

    init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        healthTransport: any HTTPRequesting,
        legacyPort: UInt16 = 8766,
        warning: @escaping @Sendable (String) -> Void = {
            Logger(subsystem: "dev.jasonpearson.automobile", category: "SdkEndpointResolver")
                .warning("\($0, privacy: .public)")
        }
    ) {
        simulatorUdid = environment["SIMULATOR_UDID"]
        self.healthTransport = healthTransport
        self.legacyPort = legacyPort
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
        guard let udid = simulatorUdid else { return Self.baseURL(port: legacyPort) }
        if let cachedURL { return cachedURL }
        for attempt in 0 ..< SdkSimulatorPort.probeCount {
            let url = Self.baseURL(port: SdkSimulatorPort.simulatorPort(udid: udid, attempt: attempt))
            // A collision, refused connection, or old SDK on a derived port is expected.
            if let info = try? await health(at: url),
               let actual = info.simulatorUdid,
               actual.lowercased() == udid.lowercased()
            {
                cachedURL = url
                return url
            }
        }
        let url = Self.baseURL(port: legacyPort)
        guard let info = try await health(at: url) else {
            throw SdkEndpointError.unavailable("AutoMobile SDK unavailable on simulator \(udid)")
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
        return url
    }

    /// One request path supplies the identity header and rejects wrong-simulator
    /// responses before any client can decode data. Transport failure clears discovery.
    func data(for original: URLRequest, transport: any HTTPRequesting) async throws -> (Data, URLResponse) {
        let endpoint = try await resolve()
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
        var request = URLRequest(url: url.appendingPathComponent("health"))
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
        return try? JSONDecoder().decode(SdkHierarchyServerInfo.self, from: result.0)
    }

    nonisolated static let identityHeader = "X-AutoMobile-Simulator-Udid"

    private nonisolated static func baseURL(port: UInt16) -> URL {
        URL(string: "http://127.0.0.1:\(port)")! // swiftlint:disable:this force_unwrapping
    }
}

enum SdkEndpointError: LocalizedError, Sendable {
    case unavailable(String)
    case wrongSimulator(expectedUdid: String, actualUdid: String)

    var errorDescription: String? {
        switch self {
        case let .unavailable(message):
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
}

private struct WrongSimulatorPayload: Decodable {
    let error: String
    let expectedUdid: String
    let actualUdid: String
}

/// Cross-package contract: lowercase UTF-8, 32-bit FNV-1a, then linear probing.
/// Keep identical to the other package; ios/sdk-port-contract.json pins the wire contract.
enum SdkSimulatorPort {
    static let rangeStart: UInt16 = 40000
    static let rangeSize = 1000
    static let probeCount = 8

    static func simulatorPort(udid: String, attempt: Int = 0) -> UInt16 {
        precondition(attempt >= 0)
        var hash: UInt32 = 2_166_136_261
        for byte in udid.lowercased().utf8 {
            hash = (hash ^ UInt32(byte)) &* 16_777_619
        }
        let offset = (UInt64(hash) + UInt64(attempt)) % UInt64(rangeSize)
        return rangeStart + UInt16(offset)
    }
}
