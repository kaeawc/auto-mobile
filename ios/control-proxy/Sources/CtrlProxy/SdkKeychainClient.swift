import AutoMobileSdkWire
import Foundation

protocol SdkKeychainDeleting: Sendable {
    func deleteKeychainItem(
        appId: String,
        sessionId: String?,
        mutationToken: String?,
        confirm: Bool,
        selector: KeychainItemSelector
    ) async throws -> KeychainDeleteOutcome
}

final class SdkKeychainClient: SdkKeychainDeleting, Sendable {
    private let baseURL: URL
    private let transport: any HTTPRequesting
    private let endpointResolver: SdkEndpointResolver?

    convenience init(port: UInt16 = 8766, endpointResolver: SdkEndpointResolver) {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 5
        config.waitsForConnectivity = false
        self.init(
            baseURL: loopbackBaseURL(port: port),
            transport: URLSessionHTTPTransport(session: URLSession(configuration: config)),
            endpointResolver: endpointResolver
        )
    }

    init(baseURL: URL, transport: any HTTPRequesting, endpointResolver: SdkEndpointResolver? = nil) {
        self.baseURL = baseURL
        self.transport = transport
        self.endpointResolver = endpointResolver
    }

    func deleteKeychainItem(
        appId: String,
        sessionId: String?,
        mutationToken: String?,
        confirm: Bool,
        selector: KeychainItemSelector
    )
        async throws -> KeychainDeleteOutcome
    {
        var request = URLRequest(url: baseURL.appendingPathComponent(SdkRoute.keychainDelete.path))
        request.httpMethod = SdkRoute.keychainDelete.method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(KeychainDeleteRequest(
            appId: appId,
            sessionId: sessionId,
            mutationToken: mutationToken,
            confirm: confirm,
            selector: selector
        ))
        do {
            let (data, response) = try await SdkEndpointResolver.requestData(
                for: request,
                transport: transport,
                resolver: endpointResolver
            )
            guard response is HTTPURLResponse else { throw SdkDatabaseError.unavailable("non-HTTP SDK response") }
            // Denials are typed SDK results even on non-2xx responses. Missing/old routes
            // and malformed bodies are transport failures, never evidence of deletion.
            return try JSONDecoder().decode(KeychainDeleteOutcome.self, from: data)
        } catch let SdkEndpointError.wrongSimulator(expected, actual) {
            throw SdkDatabaseError.wrongSimulator(expectedUdid: expected, actualUdid: actual)
        } catch {
            throw SdkDatabaseError
                .unavailable(
                    "Keychain deletion requires the target app to embed and initialize the AutoMobile SDK: \(error.localizedDescription)"
                )
        }
    }
}
