import Foundation

/// The runner's only route for target-app UserDefaults. Implementations must never use
/// UserDefaults in the runner process.
protocol SdkPreferenceFetching: Sendable {
    func list(appId: String) async throws -> [StorageSuiteInfo]
    func entries(appId: String, suiteName: String) async throws -> [StorageEntry]
    func get(appId: String, suiteName: String, key: String) async throws -> StorageEntry?
    func set(
        appId: String,
        suiteName: String,
        key: String,
        value: String,
        type: String,
        sessionId: String?,
        mutationToken: String?
    ) async throws
    func remove(appId: String, suiteName: String, key: String, sessionId: String?, mutationToken: String?) async throws
    func clear(appId: String, suiteName: String, sessionId: String?, mutationToken: String?) async throws
}

final class SdkPreferenceClient: SdkPreferenceFetching, Sendable {
    private let baseURL: URL
    private let transport: any HTTPRequesting

    convenience init(port: UInt16 = 8766) {
        let url = URL(string: "http://127.0.0.1:\(port)")! // swiftlint:disable:this force_unwrapping
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 5
        config.waitsForConnectivity = false
        self.init(baseURL: url, transport: URLSessionHTTPTransport(session: URLSession(configuration: config)))
    }

    init(baseURL: URL, transport: any HTTPRequesting) {
        self.baseURL = baseURL
        self.transport = transport
    }

    func list(appId: String) async throws -> [StorageSuiteInfo] {
        let response = try await post(.init(operation: "list", appId: appId, suiteName: "Standard"))
        return (response.files ?? []).map {
            StorageSuiteInfo(name: $0.name, displayName: $0.displayName, entryCount: $0.entryCount)
        }
    }

    func entries(appId: String, suiteName: String) async throws -> [StorageEntry] {
        try await post(.init(operation: "entries", appId: appId, suiteName: suiteName)).entries ?? []
    }

    func get(appId: String, suiteName: String, key: String) async throws -> StorageEntry? {
        try await post(.init(operation: "get", appId: appId, suiteName: suiteName, key: key)).entry
    }

    func set(
        appId: String,
        suiteName: String,
        key: String,
        value: String,
        type: String,
        sessionId: String?,
        mutationToken: String?
    )
        async throws
    {
        _ = try await post(.init(
            operation: "set",
            appId: appId,
            suiteName: suiteName,
            key: key,
            value: value,
            valueType: type,
            sessionId: sessionId,
            mutationToken: mutationToken
        ))
    }

    func remove(
        appId: String,
        suiteName: String,
        key: String,
        sessionId: String?,
        mutationToken: String?
    )
        async throws
    {
        _ = try await post(.init(
            operation: "remove",
            appId: appId,
            suiteName: suiteName,
            key: key,
            sessionId: sessionId,
            mutationToken: mutationToken
        ))
    }

    func clear(appId: String, suiteName: String, sessionId: String?, mutationToken: String?) async throws {
        _ = try await post(.init(
            operation: "clear",
            appId: appId,
            suiteName: suiteName,
            sessionId: sessionId,
            mutationToken: mutationToken
        ))
    }

    private func post(_ payload: PreferenceRequest) async throws -> PreferenceResponse {
        var request = URLRequest(url: baseURL.appendingPathComponent("preferences"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(payload)
        do {
            let (data, response) = try await transport.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw PreferenceError.unavailable("non-HTTP SDK response")
            }
            guard (200 ..< 300).contains(http.statusCode) else {
                let reason = (try? JSONDecoder().decode(PreferenceErrorPayload.self, from: data).error)
                    ?? "HTTP \(http.statusCode)"
                if http.statusCode == 400 {
                    throw PreferenceError.rejected(reason)
                }
                if http.statusCode == 409 {
                    throw PreferenceError.conflict(reason)
                }
                if http.statusCode == 403 {
                    throw PreferenceError.unauthorized(reason)
                }
                if http.statusCode == 404 {
                    throw PreferenceError.missingRoute(reason)
                }
                if http.statusCode == 503 {
                    throw PreferenceError.disabled(reason)
                }
                throw PreferenceError.server(reason)
            }
            return try JSONDecoder().decode(PreferenceResponse.self, from: data)
        } catch let error as PreferenceError {
            throw error
        } catch {
            throw PreferenceError.unavailable(error.localizedDescription)
        }
    }
}

private struct PreferenceRequest: Encodable {
    let operation: String
    let appId: String
    let suiteName: String
    var key: String?
    var value: String?
    var valueType: String?
    var sessionId: String?
    var mutationToken: String?
}

private struct PreferenceResponse: Decodable {
    let files: [PreferenceFile]?
    let entries: [StorageEntry]?
    let entry: StorageEntry?
}

private struct PreferenceFile: Decodable {
    let name: String
    let displayName: String
    let entryCount: Int
}

private struct PreferenceErrorPayload: Decodable {
    let error: String
}

private enum PreferenceError: LocalizedError {
    case unavailable(String)
    case rejected(String)
    case conflict(String)
    case unauthorized(String)
    case missingRoute(String)
    case disabled(String)
    case server(String)

    var errorDescription: String? {
        switch self {
        case let .unavailable(reason):
            return "iOS key-value storage requires the target app to embed the AutoMobile SDK, "
                + "initialize it, and call UserDefaultsInspector.shared.setEnabled(true): \(reason)"
        case let .rejected(reason):
            return "iOS key-value storage rejected the value: \(reason)"
        case let .conflict(reason):
            if reason == "app_not_active" {
                return "The target app is not active in the foreground; bring it to the foreground and retry"
            }
            if reason == "app_id_mismatch" {
                return "iOS key-value storage app id mismatch"
            }
            return "iOS key-value storage conflict: \(reason)"
        case let .unauthorized(reason):
            return "iOS key-value storage mutation is not authorized for this session: \(reason)"
        case let .missingRoute(reason):
            return "iOS key-value storage requires the target app to embed or upgrade the AutoMobile SDK: \(reason)"
        case let .disabled(reason):
            return "iOS key-value storage inspection is disabled; call UserDefaultsInspector.shared.setEnabled(true): \(reason)"
        case let .server(reason):
            return "iOS key-value storage failed: \(reason)"
        }
    }
}
