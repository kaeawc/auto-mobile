import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// Image and font bytes keyed by the asset identifiers used in the spec.
public struct PrototypeAssets: Sendable, Hashable {
    /// Encoded images, such as PNG or JPEG data.
    public let images: [String: Data]
    /// Encoded OpenType or TrueType fonts.
    public let fonts: [String: Data]
    /// No supplied assets.
    public static let none = PrototypeAssets() // swiftlint:disable:this discouraged_none_name

    /// Creates an asset collection; invalid asset bytes use the renderer's missing-asset fallback.
    public init(images: [String: Data] = [:], fonts: [String: Data] = [:]) {
        self.images = images
        self.fonts = fonts
    }
}

/// Persistence for keys explicitly listed in a prototype's `storage` block.
public enum PrototypeStorageOption: Sendable, Hashable {
    /// Keep values only for this presentation. This is the embedded view's default.
    case none // swiftlint:disable:this discouraged_none_name
    /// Store values in the app's Application Support directory, partitioned by prototype id.
    case fileBacked
    /// Store values in an app-selected directory, using the same file format and id partitioning.
    case directory(URL)

    func coordinator(clock: PrototypeClock = SystemPrototypeClock()) -> PrototypeStorageCoordinator? {
        switch self {
        case .none: nil
        case .fileBacked: PrototypeStorageCoordinator.fileBacked(clock: clock)
        case let .directory(url):
            PrototypeStorageCoordinator(store: FilePrototypeStorageStore(directory: url), clock: clock)
        }
    }
}

/// Networking for an embedded prototype, independent of any AutoMobile server.
public struct PrototypeNetworkConfiguration: Sendable {
    /// An app HTTP hook. Honour cancellation, the URLRequest timeout, and your app's egress policy.
    /// The returned body is bounded by the renderer before it enters prototype data.
    public typealias Client = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

    let device: any PrototypeHttpClient
    private let handler: (any PrototypeHttpClient)?

    /// The renderer's bounded, ephemeral URLSession client and its standard egress checks.
    public static let `default` = PrototypeNetworkConfiguration()

    #if canImport(Network)
        /// A transport that enforces the egress policy by dialing only checked IP addresses.
        public static func pinned(allowsCleartext: Bool = false) -> PrototypeNetworkConfiguration {
            PrototypeNetworkConfiguration(device: PrototypePinnedHttpClient(allowsCleartext: allowsCleartext))
        }
    #endif

    /// Core-owned clients share one route; no embedded host handler can bypass their policy.
    init(device: any PrototypeHttpClient) {
        self.device = device
        handler = nil
    }

    /// Uses the standard URLSession client unless `deviceClient` is supplied. A host handler
    /// receives only host-routed requests (including omitted `via`); explicit device requests
    /// always use the device client. Without a handler, host requests use the device client too.
    public init(deviceClient: Client? = nil, hostHandler: Client? = nil) {
        device = deviceClient.map { EmbeddedHttpClient(client: $0) } ?? PrototypeURLSessionClient()
        handler = hostHandler.map { EmbeddedHttpClient(client: $0) }
    }

    @MainActor
    func driver(clock: PrototypeClock = SystemPrototypeClock()) -> PrototypeRequestDriver {
        PrototypeRequestDriver(clock: clock, device: device, hostRoute: hostRoute)
    }

    /// Swaps clients for subsequent requests while in-flight requests retain their original client.
    @MainActor
    func apply(to driver: PrototypeRequestDriver) {
        driver.updateClients(device: device, hostRoute: hostRoute)
    }

    @MainActor private var hostRoute: PrototypeRequestDriver.HostRoute {
        handler.map { .handler($0) } ?? .deviceClient
    }
}

private struct EmbeddedHttpClient: PrototypeHttpClient {
    let client: PrototypeNetworkConfiguration.Client
    var nowMs: @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 }

    func perform(_ request: PrototypeHttpRequest) async throws -> PrototypeHttpResponse {
        let started = nowMs()
        func elapsed() -> Int { max(0, Int((nowMs() - started).rounded())) }
        if let problem = PrototypeHttpHeaderCheck.problem(in: request.headers) {
            throw PrototypeHttpFailure(error: problem, durationMs: 0)
        }
        guard let urlRequest = PrototypeURLSessionClient.urlRequest(for: request) else {
            throw PrototypeHttpFailure(error: .init(.invalidURL, "Not an absolute HTTP URL"), durationMs: 0)
        }
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await client(urlRequest)
            try Task.checkCancellation()
        } catch {
            let code: PrototypeRequestErrorCode = error is CancellationError ||
                (error as? URLError)?.code == .cancelled ? .cancelled :
                (error as? URLError)?.code == .timedOut ? .timeout : .network
            throw PrototypeHttpFailure(error: .init(code, error.localizedDescription), durationMs: elapsed())
        }
        guard !(200 ..< 300).contains(response.statusCode) || data.count <= request.maxResponseBytes else {
            throw PrototypeHttpFailure(error: .init(.tooLarge, "Response byte limit exceeded"), durationMs: elapsed())
        }
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            if let key = entry.key as? String, let value = entry.value as? String {
                result[key.lowercased()] = value
            }
        }
        return PrototypeHttpResponse(
            status: response.statusCode, headers: headers,
            body: (200 ..< 300).contains(response.statusCode) ? data : Data(), durationMs: elapsed()
        )
    }
}

/// Show-only options for an embedded presentation.
public struct PrototypeEmbeddedOptions: Sendable, Hashable {
    public let locale: String?
    public init(locale: String? = nil) { self.locale = locale }
}
