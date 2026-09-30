#if DEBUG && !os(watchOS)
    import Foundation

    /// UserDefaults requests execute in the host app, never in the XCUITest runner.
    struct SdkPreferenceRouteHandler {
        private let driver: () -> (any UserDefaultsDriver)?
        private let bundleId: () -> String?
        private let currentSessionId: () -> String?

        init(
            driver: @escaping () -> (any UserDefaultsDriver)? = { UserDefaultsInspector.shared.getDriver() },
            bundleId: @escaping () -> String? = { Bundle.main.bundleIdentifier },
            currentSessionId: @escaping () -> String? = { AutoMobileSDK.shared.currentSessionId() }
        ) {
            self.driver = driver
            self.bundleId = bundleId
            self.currentSessionId = currentSessionId
        }

        func handle(body: Data) -> SdkRouteResponse {
            guard let request = try? JSONDecoder().decode(SdkPreferenceRequest.self, from: body) else {
                return error(400, "bad_request")
            }
            guard let appId = bundleId(), appId == request.appId else {
                return error(409, "app_id_mismatch")
            }
            guard let driver = driver() else {
                return error(503, "user_defaults_inspection_disabled")
            }
            let suite = request.suiteName == "Standard" || request.suiteName.isEmpty ? nil : request.suiteName

            switch request.operation {
            case "list":
                let files = driver.getSuites().map {
                    SdkPreferenceFile(
                        name: $0.name ?? "Standard",
                        displayName: $0.displayName,
                        entryCount: $0.entryCount
                    )
                }
                return encode(SdkPreferencePayload(files: files))
            case "entries":
                let entries = driver.getValues(suiteName: suite).map(redact)
                return encode(SdkPreferencePayload(entries: entries))
            case "get":
                guard let key = request.key else { return error(400, "missing_key") }
                return encode(SdkPreferencePayload(
                    entry: driver.getValue(suiteName: suite, key: key)
                        .map(redact)
                ))
            case "set":
                guard canMutate(request) else { return error(403, "mutation_not_authorized") }
                guard let key = request.key, let value = request.value, let type = request.valueType,
                      let parsed = Self.parse(value, type: type) else { return error(400, "invalid_preference_value") }
                driver.setValue(suiteName: suite, key: key, value: parsed.value, type: parsed.type)
                return encode(SdkPreferencePayload())
            case "remove":
                guard canMutate(request) else { return error(403, "mutation_not_authorized") }
                guard let key = request.key else { return error(400, "missing_key") }
                driver.removeValue(suiteName: suite, key: key)
                return encode(SdkPreferencePayload())
            case "clear":
                guard canMutate(request) else { return error(403, "mutation_not_authorized") }
                driver.clear(suiteName: suite)
                return encode(SdkPreferencePayload())
            default:
                return error(400, "unknown_operation")
            }
        }

        private func canMutate(_ request: SdkPreferenceRequest) -> Bool {
            DatabaseInspector.shared.canMutate(
                sessionId: request.sessionId, currentSessionId: currentSessionId(),
                mutationToken: request.mutationToken
            )
        }

        private func redact(_ pair: KeyValuePair) -> SdkPreferenceEntry {
            let sensitive = StorageInspectionAccess.isSensitive(
                pair.key, configured: DatabaseInspector.shared.inspectionConfiguration.sensitiveKeys
            )
            return SdkPreferenceEntry(pair, value: sensitive && pair.value != nil ? "[REDACTED]" : pair.value)
        }

        private static func parse(_ value: String, type: String) -> (value: Any, type: KeyValueType)? {
            switch type {
            case "STRING": return (value, .string)
            case "INT":
                guard let parsed = Int(value) else { return nil }
                return (parsed, .int)
            case "FLOAT", "DOUBLE":
                guard let parsed = Double(value), parsed.isFinite else { return nil }
                return (parsed, .double)
            case "BOOLEAN":
                switch value.lowercased() {
                case "true", "1", "yes": return (true, .bool)
                case "false", "0", "no": return (false, .bool)
                default: return nil
                }
            case "DATA":
                guard let parsed = Data(base64Encoded: value) else { return nil }
                return (parsed, .data)
            case "DATE":
                let fractional = ISO8601DateFormatter()
                fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                guard let parsed = fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
                else { return nil }
                return (parsed, .date)
            case "ARRAY", "DICTIONARY":
                guard let data = value.data(using: .utf8),
                      let parsed = try? JSONSerialization.jsonObject(with: data),
                      PropertyListSerialization.propertyList(parsed, isValidFor: .binary) else { return nil }
                if type == "ARRAY", let array = parsed as? [Any] { return (array, .array) }
                if type == "DICTIONARY", let dictionary = parsed as? [String: Any] { return (dictionary, .dictionary) }
                return nil
            default: return nil
            }
        }

        private func encode(_ payload: SdkPreferencePayload) -> SdkRouteResponse {
            guard let data = try? JSONEncoder().encode(payload) else { return error(500, "encode_failed") }
            return SdkRouteResponse(statusCode: 200, body: data)
        }

        private func error(_ status: Int, _ code: String) -> SdkRouteResponse {
            let data = (try? JSONEncoder().encode(SdkPreferenceError(error: code))) ?? Data()
            return SdkRouteResponse(statusCode: status, body: data)
        }
    }

    private struct SdkPreferenceRequest: Decodable {
        let operation: String
        let appId: String
        let suiteName: String
        let key: String?
        let value: String?
        let valueType: String?
        let sessionId: String?
        let mutationToken: String?
    }

    private struct SdkPreferenceError: Encodable {
        let error: String
    }

    private struct SdkPreferenceFile: Encodable {
        let name: String
        let displayName: String
        let entryCount: Int
    }

    private struct SdkPreferenceEntry: Encodable {
        let key: String
        let value: String?
        let type: String

        init(_ pair: KeyValuePair, value: String?) {
            key = pair.key
            self.value = value
            type = pair.type.rawValue.uppercased() == "BOOL" ? "BOOLEAN" : pair.type.rawValue.uppercased()
        }
    }

    private struct SdkPreferencePayload: Encodable {
        var files: [SdkPreferenceFile]?
        var entries: [SdkPreferenceEntry]?
        var entry: SdkPreferenceEntry?
    }
#endif
