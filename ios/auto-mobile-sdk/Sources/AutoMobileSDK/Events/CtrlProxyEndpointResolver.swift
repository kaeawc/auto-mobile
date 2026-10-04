import Foundation
import os

struct CtrlProxyHealthResponse: Sendable {
    let statusCode: Int
    let data: Data
}

protocol CtrlProxyHealthProbing: Sendable {
    func health(at url: URL, completion: @escaping @Sendable (CtrlProxyHealthResponse?) -> Void)
}

final class URLSessionCtrlProxyHealthProbe: CtrlProxyHealthProbing, Sendable {
    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 0.5
        config.timeoutIntervalForResource = 0.5
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    func health(at url: URL, completion: @escaping @Sendable (CtrlProxyHealthResponse?) -> Void) {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        session.dataTask(with: request) { data, response, error in
            if let error = error {
                // Refused connections are expected while probing unoccupied runner ports.
                InternalLogger.debug("CtrlProxy health probe failed: \(error.localizedDescription)")
            }
            guard error == nil, let data = data, let response = response as? HTTPURLResponse else {
                completion(nil)
                return
            }
            completion(CtrlProxyHealthResponse(statusCode: response.statusCode, data: data))
        }.resume()
    }
}

protocol CtrlProxyEndpointResolving: Sendable {
    var requiresSimulatorDiscovery: Bool { get }
    func resolve(completion: @escaping @Sendable (URL?) -> Void)
    func invalidate(endpoint: URL)
}

/// Finds this simulator's runner by verifying its /health deviceId.
/// The bounded range is 8765..<8797, skipping the SDK hierarchy server at 8766.
/// A custom daemon AUTOMOBILE_PORT_RANGE_START outside 8765..8796 is not found:
/// events remain pending without delivery, bounded by FileEventPersistence's cap.
/// Callers initiate discovery off the event buffer's flush thread. Negative results
/// are cached for five seconds by default, measured from the end of a scan.
final class CtrlProxyEndpointResolver: CtrlProxyEndpointResolving, Sendable {
    /// Probe at most 32 candidate ports, minus the reserved hierarchy port.
    static let candidatePortCount = 32
    static let rangeStart = 8765
    static let defaultEndpoint = URL(string: "http://localhost:8765/sdk-events")

    private struct HealthInfo: Decodable {
        let status: String
        let deviceId: String?
    }

    private struct State: Sendable {
        var cachedURL: URL?
        var lastNegativeResult: Date?
        var resolving = false
        var completions: [@Sendable (URL?) -> Void] = []
    }

    private enum ResolutionAction {
        case complete(URL?)
        case probe
        case waiting
    }

    private let lock = OSAllocatedUnfairLock(initialState: State())
    private let simulatorUdid: String?
    private let healthProbe: any CtrlProxyHealthProbing
    private let dateProvider: any DateProvider
    private let minimumRetryInterval: TimeInterval
    private let ports: [Int]

    var requiresSimulatorDiscovery: Bool { simulatorUdid != nil }

    init(
        simulatorUdid: String? = ProcessInfo.processInfo.environment["SIMULATOR_UDID"],
        healthProbe: any CtrlProxyHealthProbing = URLSessionCtrlProxyHealthProbe(),
        dateProvider: any DateProvider = SystemDateProvider(),
        minimumRetryInterval: TimeInterval = 5
    ) {
        self.simulatorUdid = simulatorUdid
        self.healthProbe = healthProbe
        self.dateProvider = dateProvider
        self.minimumRetryInterval = max(0, minimumRetryInterval)
        ports = (Self.rangeStart ..< Self.rangeStart + Self.candidatePortCount).filter { $0 != 8766 }
    }

    func resolve(completion: @escaping @Sendable (URL?) -> Void) {
        guard requiresSimulatorDiscovery else {
            completion(Self.defaultEndpoint)
            return
        }
        let now = dateProvider.now()
        let action = lock.withLock { state -> ResolutionAction in
            if let cached = state.cachedURL { return .complete(cached) }
            if let last = state.lastNegativeResult, now.timeIntervalSince(last) < minimumRetryInterval {
                return .complete(nil)
            }
            state.completions.append(completion)
            if state.resolving { return .waiting }
            state.resolving = true
            return .probe
        }
        switch action {
        case let .complete(url): completion(url)
        case .probe: probe(at: 0)
        case .waiting: break
        }
    }

    /// Ignore a late failure from an endpoint superseded by a newer resolution.
    func invalidate(endpoint: URL) {
        lock.withLock { state in
            if state.cachedURL == endpoint {
                state.cachedURL = nil
                state.lastNegativeResult = nil
            }
        }
    }

    private func probe(at index: Int) {
        guard index < ports.count,
              let healthURL = URL(string: "http://localhost:\(ports[index])/health")
        else {
            finish(url: nil)
            return
        }
        healthProbe.health(at: healthURL) { [self] response in
            if let response = response, response.statusCode == 200,
               let info = try? JSONDecoder().decode(HealthInfo.self, from: response.data),
               info.status == "ok", let actual = info.deviceId,
               actual.lowercased() == simulatorUdid?.lowercased()
            {
                finish(url: URL(string: "http://localhost:\(ports[index])/sdk-events"))
            } else {
                probe(at: index + 1)
            }
        }
    }

    private func finish(url: URL?) {
        let now = dateProvider.now()
        let completions = lock.withLock { state in
            state.cachedURL = url
            state.lastNegativeResult = url == nil ? now : nil
            state.resolving = false
            let completions = state.completions
            state.completions.removeAll()
            return completions
        }
        for completion in completions {
            completion(url)
        }
    }
}
