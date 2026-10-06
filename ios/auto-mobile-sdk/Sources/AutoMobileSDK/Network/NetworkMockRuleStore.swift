#if DEBUG
    import Foundation
    import os

    struct NetworkMockRuleDTO: Codable, Equatable, Sendable {
        let mockId: String
        let host: String
        let path: String
        let method: String
        let limit: Int?
        let remaining: Int?
        let statusCode: Int
        let responseHeaders: [String: String]
        let responseBody: String
        let contentType: String
    }

    struct NetworkErrorSimulationDTO: Codable, Equatable, Sendable {
        let enabled: Bool
        let errorType: String?
        let limit: Int?
        let expiresAtEpochMs: Int64?
    }

    public enum NetworkFaultTransport: String, Codable, Equatable, Sendable {
        case urlSession
        case webSocket
        case nwConnection
        case webView
    }

    public enum NetworkFaultAction: String, Codable, Equatable, Sendable {
        case response
        case status
        case error
        case latency
        case bandwidth
        case dropBytes
        case closeConnection
        case rejectFrame
    }

    public struct NetworkFaultRuleDTO: Codable, Equatable, Sendable {
        public let faultId: String
        public let transport: NetworkFaultTransport?
        public let host: String?
        public let port: Int?
        public let scheme: String?
        public let path: String?
        public let method: String?
        public let headers: [String: String]?
        public let origin: String?
        public let connectionId: String?
        public let sessionId: String?
        public let action: NetworkFaultAction
        public let statusCode: Int?
        public let responseHeaders: [String: String]?
        public let responseBody: String?
        public let contentType: String?
        public let errorType: String?
        public let delayMs: Int?
        public let bandwidthBytesPerSecond: Int?
        public let dropBytes: Int?
        public let limit: Int?
        public let expiresAtEpochMs: Int64?
        public let scope: String?
        public let dryRun: Bool

        public init(
            faultId: String, transport: NetworkFaultTransport?, host: String?, port: Int?,
            scheme: String?, path: String?, method: String?, headers: [String: String]?,
            origin: String?, connectionId: String?, sessionId: String?, action: NetworkFaultAction,
            statusCode: Int?, responseHeaders: [String: String]?, responseBody: String?,
            contentType: String?, errorType: String?, delayMs: Int?,
            bandwidthBytesPerSecond: Int?, dropBytes: Int?, limit: Int?,
            expiresAtEpochMs: Int64?, scope: String?, dryRun: Bool
        ) {
            self.faultId = faultId; self.transport = transport; self.host = host; self.port = port
            self.scheme = scheme; self.path = path; self.method = method; self.headers = headers
            self.origin = origin; self.connectionId = connectionId; self.sessionId = sessionId
            self.action = action; self.statusCode = statusCode; self.responseHeaders = responseHeaders
            self.responseBody = responseBody; self.contentType = contentType; self.errorType = errorType
            self.delayMs = delayMs; self.bandwidthBytesPerSecond = bandwidthBytesPerSecond
            self.dropBytes = dropBytes; self.limit = limit; self.expiresAtEpochMs = expiresAtEpochMs
            self.scope = scope; self.dryRun = dryRun
        }
    }

    public final class NetworkMockRuleStore: Sendable {
        static let shared = NetworkMockRuleStore()

        struct ErrorSimulation: Equatable, Sendable {
            let errorType: String
        }

        struct MatchedRule: Equatable, Sendable {
            let mockId: String
            let statusCode: Int
            let responseHeaders: [String: String]
            let responseBody: String
            let contentType: String
        }

        public struct FaultDecision: Equatable, Sendable {
            public let faultId: String
            public let action: NetworkFaultAction
            public let statusCode: Int?
            public let responseHeaders: [String: String]
            public let responseBody: String?
            public let contentType: String?
            public let errorType: String?
            public let delayMs: Int?
            public let bandwidthBytesPerSecond: Int?
            public let dropBytes: Int?
            public let dryRun: Bool
        }

        public struct FaultRequest: Equatable, Sendable {
            public let transport: NetworkFaultTransport
            public let host: String?
            public let port: Int?
            public let scheme: String?
            public let path: String?
            public let method: String?
            public let headers: [String: String]
            public let origin: String?
            public let connectionId: String?
            public let sessionId: String?

            public init(
                transport: NetworkFaultTransport,
                host: String?,
                port: Int?,
                scheme: String?,
                path: String?,
                method: String?,
                headers: [String: String],
                origin: String?,
                connectionId: String?,
                sessionId: String?
            ) {
                self.transport = transport; self.host = host; self.port = port; self.scheme = scheme
                self.path = path; self.method = method; self.headers = headers; self.origin = origin
                self.connectionId = connectionId; self.sessionId = sessionId
            }
        }

        private struct CompiledRule: Sendable {
            let mockId: String
            let host: NSRegularExpression
            let path: NSRegularExpression
            let method: String
            let limit: Int?
            var remaining: Int?
            let statusCode: Int
            let responseHeaders: [String: String]
            let responseBody: String
            let contentType: String

            /// Same `mockId` and an unchanged definition: the host re-sent a rule this store already holds.
            func isSameDefinition(as other: CompiledRule) -> Bool {
                mockId == other.mockId && limit == other.limit && method == other.method
                    && host.pattern == other.host.pattern && path.pattern == other.path.pattern
            }
        }

        private struct State: Sendable {
            var rules: [CompiledRule] = []
            var faultRules: [CompiledFaultRule] = []
            var consumedConnections = Set<String>()
            var consumedSessions = Set<String>()
            var errorSimulation: CompiledErrorSimulation?
        }

        private let state = OSAllocatedUnfairLock<State>(initialState: State())
        private let dateProvider: DateProvider

        public init() {
            dateProvider = SystemDateProvider()
        }

        init(dateProvider: DateProvider) {
            self.dateProvider = dateProvider
        }

        /// Replace the rule list. The host re-sends its whole list on every change and reconnect, so a rule
        /// this store already holds keeps its use counter instead of being re-armed from the incoming
        /// `remaining` (issue #10060). A changed rule, or a new app process, starts with a fresh counter.
        func setRules(_ dtos: [NetworkMockRuleDTO]) {
            let compiled = dtos.compactMap { dto -> CompiledRule? in
                do {
                    let host = try NSRegularExpression(pattern: dto.host)
                    let path = try NSRegularExpression(pattern: dto.path)
                    return CompiledRule(
                        mockId: dto.mockId,
                        host: host,
                        path: path,
                        method: dto.method,
                        limit: dto.limit,
                        remaining: dto.remaining ?? dto.limit,
                        statusCode: dto.statusCode,
                        responseHeaders: dto.responseHeaders,
                        responseBody: dto.responseBody,
                        contentType: dto.contentType
                    )
                } catch {
                    InternalLogger.debug("[NetworkMockRuleStore] Skipping invalid regex for \(dto.mockId): \(error)")
                    return nil
                }
            }

            state.withLock { state in
                let previous = state.rules
                state.rules = compiled.map { rule in
                    guard let held = previous.first(where: { $0.isSameDefinition(as: rule) }) else {
                        return rule
                    }
                    var carried = rule
                    carried.remaining = held.remaining
                    return carried
                }
            }
        }

        public func setFaultRules(_ dtos: [NetworkFaultRuleDTO]) {
            let compiled = dtos.compactMap { dto -> CompiledFaultRule? in
                do {
                    return try CompiledFaultRule(
                        dto: dto,
                        host: dto.host.map { try NSRegularExpression(pattern: $0) },
                        path: dto.path.map { try NSRegularExpression(pattern: $0) }
                    )
                } catch {
                    InternalLogger.debug("[NetworkMockRuleStore] Skipping invalid fault rule \(dto.faultId): \(error)")
                    return nil
                }
            }
            state.withLock { state in
                state.faultRules = compiled
                state.consumedConnections.removeAll()
                state.consumedSessions.removeAll()
            }
        }

        public func clearFaultRules() {
            state.withLock { state in
                state.faultRules.removeAll()
                state.consumedConnections.removeAll()
                state.consumedSessions.removeAll()
            }
        }

        public func evaluate(_ request: FaultRequest) -> FaultDecision? {
            state.withLock { state in
                for index in state.faultRules.indices {
                    let rule = state.faultRules[index]
                    guard !isExpired(rule.expiresAtEpochMs),
                          matches(rule, request: request)
                    else {
                        continue
                    }
                    if !rule.dryRun, !Self.consume(
                        rule: &state.faultRules[index], request: request,
                        consumedConnections: &state.consumedConnections,
                        consumedSessions: &state.consumedSessions
                    ) {
                        continue
                    }
                    return FaultDecision(
                        faultId: rule.faultId,
                        action: rule.action,
                        statusCode: rule.statusCode,
                        responseHeaders: rule.responseHeaders,
                        responseBody: rule.responseBody,
                        contentType: rule.contentType,
                        errorType: rule.errorType,
                        delayMs: rule.delayMs,
                        bandwidthBytesPerSecond: rule.bandwidthBytesPerSecond,
                        dropBytes: rule.dropBytes,
                        dryRun: rule.dryRun
                    )
                }
                return nil
            }
        }

        func setErrorSimulation(_ dto: NetworkErrorSimulationDTO) {
            state.withLock { state in
                guard dto.enabled, let errorType = dto.errorType else {
                    state.errorSimulation = nil
                    return
                }

                state.errorSimulation = CompiledErrorSimulation(
                    errorType: errorType,
                    remaining: dto.limit,
                    expiresAtEpochMs: dto.expiresAtEpochMs
                )
            }
        }

        func activeErrorSimulation() -> ErrorSimulation? {
            state.withLock { state in
                guard var simulation = state.errorSimulation else {
                    return nil
                }

                if let expiresAtEpochMs = simulation.expiresAtEpochMs,
                   currentEpochMs() >= expiresAtEpochMs
                {
                    state.errorSimulation = nil
                    return nil
                }

                if let remaining = simulation.remaining {
                    guard remaining > 0 else {
                        state.errorSimulation = nil
                        return nil
                    }
                    simulation.remaining = remaining - 1
                    state.errorSimulation = simulation.remaining == 0 ? nil : simulation
                }

                return ErrorSimulation(errorType: simulation.errorType)
            }
        }

        func findMatchingRule(host: String, path: String, method: String) -> MatchedRule? {
            state.withLock { state in
                for index in state.rules.indices {
                    let rule = state.rules[index]
                    if rule.method != "*", rule.method.caseInsensitiveCompare(method) != .orderedSame {
                        continue
                    }
                    guard Self.matches(rule.host, host), Self.matches(rule.path, path) else {
                        continue
                    }
                    if var remaining = rule.remaining {
                        remaining -= 1
                        state.rules[index].remaining = remaining
                        if remaining < 0 {
                            continue
                        }
                    }
                    return MatchedRule(
                        mockId: rule.mockId,
                        statusCode: rule.statusCode,
                        responseHeaders: rule.responseHeaders,
                        responseBody: rule.responseBody,
                        contentType: rule.contentType
                    )
                }
                return nil
            }
        }

        private struct CompiledErrorSimulation: Sendable {
            let errorType: String
            var remaining: Int?
            let expiresAtEpochMs: Int64?
        }

        private struct CompiledFaultRule: Sendable {
            let faultId: String
            let transport: NetworkFaultTransport?
            let host: NSRegularExpression?
            let port: Int?
            let scheme: String?
            let path: NSRegularExpression?
            let method: String?
            let headers: [String: String]
            let origin: String?
            let connectionId: String?
            let sessionId: String?
            let action: NetworkFaultAction
            let statusCode: Int?
            let responseHeaders: [String: String]
            let responseBody: String?
            let contentType: String?
            let errorType: String?
            let delayMs: Int?
            let bandwidthBytesPerSecond: Int?
            let dropBytes: Int?
            var remaining: Int?
            let expiresAtEpochMs: Int64?
            let scope: String?
            let dryRun: Bool

            init(dto: NetworkFaultRuleDTO, host: NSRegularExpression?, path: NSRegularExpression?) {
                faultId = dto.faultId
                transport = dto.transport
                self.host = host
                port = dto.port
                scheme = dto.scheme
                self.path = path
                method = dto.method
                headers = dto.headers ?? [:]
                origin = dto.origin
                connectionId = dto.connectionId
                sessionId = dto.sessionId
                action = dto.action
                statusCode = dto.statusCode
                responseHeaders = dto.responseHeaders ?? [:]
                responseBody = dto.responseBody
                contentType = dto.contentType
                errorType = dto.errorType
                delayMs = dto.delayMs
                bandwidthBytesPerSecond = dto.bandwidthBytesPerSecond
                dropBytes = dto.dropBytes
                remaining = dto.limit
                expiresAtEpochMs = dto.expiresAtEpochMs
                scope = dto.scope
                dryRun = dto.dryRun
            }
        }

        private func matches(_ rule: CompiledFaultRule, request: FaultRequest) -> Bool {
            guard rule.transport == nil || rule.transport == request.transport,
                  rule.port == nil || rule.port == request.port,
                  rule.scheme == nil || rule.scheme?.caseInsensitiveCompare(request.scheme ?? "") == .orderedSame,
                  rule.method == nil || rule.method == "*" || rule.method?
                  .caseInsensitiveCompare(request.method ?? "") == .orderedSame,
                  rule.origin == nil || rule.origin == request.origin,
                  rule.connectionId == nil || rule.connectionId == request.connectionId,
                  rule.sessionId == nil || rule.sessionId == request.sessionId
            else {
                return false
            }
            if let host = rule.host, !Self.matches(host, request.host ?? "") { return false }
            if let path = rule.path, !Self.matches(path, request.path ?? "") { return false }
            return rule.headers.allSatisfy { key, value in
                request.headers.contains {
                    $0.key.caseInsensitiveCompare(key) == .orderedSame &&
                        $0.value.caseInsensitiveCompare(value) == .orderedSame
                }
            }
        }

        private static func consume(
            rule: inout CompiledFaultRule, request: FaultRequest,
            consumedConnections: inout Set<String>, consumedSessions: inout Set<String>
        )
            -> Bool
        {
            switch rule.scope {
            case "connection":
                if let id = request.connectionId,
                   consumedConnections.contains("\(rule.faultId):\(id)")
                {
                    return false
                }
            case "session":
                if let id = request.sessionId,
                   consumedSessions.contains("\(rule.faultId):\(id)")
                {
                    return false
                }
            default:
                break
            }
            if rule.scope == nil, let remaining = rule.remaining {
                guard remaining > 0 else { return false }
                rule.remaining = remaining - 1
            }
            switch rule.scope {
            case "connection":
                guard let id = request.connectionId else { return true }
                return consumedConnections.insert("\(rule.faultId):\(id)").inserted
            case "session":
                guard let id = request.sessionId else { return true }
                return consumedSessions.insert("\(rule.faultId):\(id)").inserted
            default:
                return true
            }
        }

        public func clearSession(_ sessionId: String) {
            state.withLock { state in
                state.faultRules.removeAll { $0.sessionId == sessionId }
                state.consumedSessions = state.consumedSessions.filter { !$0.hasSuffix(":\(sessionId)") }
            }
        }

        private func isExpired(_ epochMs: Int64?) -> Bool {
            guard let epochMs else { return false }
            return currentEpochMs() >= epochMs
        }

        private static func matches(_ regex: NSRegularExpression, _ value: String) -> Bool {
            let range = NSRange(value.startIndex ..< value.endIndex, in: value)
            return regex.firstMatch(in: value, range: range) != nil
        }

        private func currentEpochMs() -> Int64 {
            Int64(dateProvider.now().timeIntervalSince1970 * 1000)
        }
    }
#endif
