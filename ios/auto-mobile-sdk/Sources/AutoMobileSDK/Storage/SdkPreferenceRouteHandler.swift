#if DEBUG && !os(watchOS)
    import Foundation

    /// UserDefaults requests execute in the host app, never in the XCUITest runner.
    struct SdkPreferenceRouteHandler {
        private let driver: () -> (any UserDefaultsDriver)?
        private let bundleId: () -> String?
        private let currentSessionId: () -> String?
        private let suiteIsValid: (String) -> Bool

        init(
            driver: @escaping () -> (any UserDefaultsDriver)? = { UserDefaultsInspector.shared.getDriver() },
            bundleId: @escaping () -> String? = { Bundle.main.bundleIdentifier },
            currentSessionId: @escaping () -> String? = { AutoMobileSDK.shared.currentSessionId() },
            suiteIsValid: @escaping (String) -> Bool = UserDefaultsStoreResolver.defaultSuiteIsValid
        ) {
            self.driver = driver
            self.bundleId = bundleId
            self.currentSessionId = currentSessionId
            self.suiteIsValid = suiteIsValid
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
            let persistentReader = driver as? any PersistentDomainReading
            let resolver = UserDefaultsStoreResolver(bundleIdentifier: appId, suiteIsValid: suiteIsValid)

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
                guard let store = resolver.resolve(request.suiteName) else { return error(400, "invalid_store_name") }
                let entries = driver.getValues(suiteName: store.suiteName).map(redact)
                return encode(SdkPreferencePayload(entries: entries, resolvedStore: store.label))
            case "get":
                guard let key = request.key else { return error(400, "missing_key") }
                guard let store = resolver.resolve(request.suiteName) else { return error(400, "invalid_store_name") }
                return encode(SdkPreferencePayload(
                    entry: driver.getValue(suiteName: store.suiteName, key: key)
                        .map(redact),
                    resolvedStore: store.label
                ))
            case "set":
                guard canMutate(request) else { return error(403, "mutation_not_authorized") }
                guard let key = request.key, let value = request.value, let type = request.valueType,
                      let parsed = Self.parse(value, type: type) else { return error(400, "invalid_preference_value") }
                guard let store = resolver.resolve(request.suiteName) else { return error(400, "invalid_store_name") }
                driver.setValue(suiteName: store.suiteName, key: key, value: parsed.value, type: parsed.type)
                guard let stored = verificationValue(driver, persistentReader, store: store, appId: appId, key: key),
                      stored.type == parsed.type, Self.valuesMatch(stored, parsed)
                else {
                    return error(500, "write_verification_failed")
                }
                let effective = driver.getValue(suiteName: store.suiteName, key: key)
                let differs = effective.map { $0.type != parsed.type || !Self.valuesMatch($0, parsed) } ?? true
                return encode(SdkPreferencePayload(
                    resolvedStore: store.label, effectiveValueDiffers: differs ? true : nil
                ))
            case "remove":
                guard canMutate(request) else { return error(403, "mutation_not_authorized") }
                guard let key = request.key else { return error(400, "missing_key") }
                guard let store = resolver.resolve(request.suiteName) else { return error(400, "invalid_store_name") }
                driver.removeValue(suiteName: store.suiteName, key: key)
                if verificationValue(driver, persistentReader, store: store, appId: appId, key: key) != nil {
                    return error(500, "write_verification_failed")
                }
                return encode(SdkPreferencePayload(resolvedStore: store.label))
            case "clear":
                guard canMutate(request) else { return error(403, "mutation_not_authorized") }
                guard let store = resolver.resolve(request.suiteName) else { return error(400, "invalid_store_name") }
                let keys: Set<String>
                if let persistentReader {
                    keys = persistentReader.persistentKeys(domain: store.suiteName ?? appId, suiteName: store.suiteName)
                } else {
                    keys = Set(driver.getValues(suiteName: store.suiteName).map(\.key))
                }
                driver.clear(suiteName: store.suiteName)
                guard keys.allSatisfy({
                    verificationValue(driver, persistentReader, store: store, appId: appId, key: $0) == nil
                }) else { return error(500, "write_verification_failed") }
                return encode(SdkPreferencePayload(resolvedStore: store.label))
            default:
                return error(400, "unknown_operation")
            }
        }

        private func verificationValue(
            _ driver: any UserDefaultsDriver,
            _ reader: (any PersistentDomainReading)?,
            store: ResolvedStore,
            appId: String,
            key: String
        )
            -> KeyValuePair?
        {
            if let reader {
                return reader.persistentValue(domain: store.suiteName ?? appId, suiteName: store.suiteName, key: key)
            }
            return driver.getValue(suiteName: store.suiteName, key: key)
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

        private static func valuesMatch(_ stored: KeyValuePair, _ written: (value: Any, type: KeyValueType)) -> Bool {
            let wireType = written.type == .bool ? "BOOLEAN" : written.type.rawValue.uppercased()
            guard let value = stored.value, let readBack = parse(value, type: wireType) else { return false }
            switch written.type {
            case .string: return (readBack.value as? String) == (written.value as? String)
            case .int: return (readBack.value as? Int) == (written.value as? Int)
            case .double: return (readBack.value as? Double) == (written.value as? Double)
            case .bool: return (readBack.value as? Bool) == (written.value as? Bool)
            case .data: return (readBack.value as? Data) == (written.value as? Data)
            case .date:
                guard let actual = readBack.value as? Date, let expected = written.value as? Date else { return false }
                return abs(actual.timeIntervalSince(expected)) <= 0.001
            case .array, .dictionary:
                guard let actual = readBack.value as? NSObject else { return false }
                return actual.isEqual(written.value)
            case .unknown: return false
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
        var resolvedStore: String?
        var effectiveValueDiffers: Bool?
    }
#endif
