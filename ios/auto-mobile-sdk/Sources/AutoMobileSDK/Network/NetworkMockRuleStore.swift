#if DEBUG
import Foundation

struct NetworkMockRuleDTO: Codable, Equatable {
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

struct NetworkErrorSimulationDTO: Codable, Equatable {
    let enabled: Bool
    let errorType: String?
    let limit: Int?
    let expiresAtEpochMs: Int64?
}

final class NetworkMockRuleStore: @unchecked Sendable {
    static let shared = NetworkMockRuleStore()

    struct ErrorSimulation: Equatable {
        let errorType: String
    }

    struct MatchedRule: Equatable {
        let mockId: String
        let statusCode: Int
        let responseHeaders: [String: String]
        let responseBody: String
        let contentType: String
    }

    private struct CompiledRule {
        let mockId: String
        let host: NSRegularExpression
        let path: NSRegularExpression
        let method: String
        var remaining: Int?
        let statusCode: Int
        let responseHeaders: [String: String]
        let responseBody: String
        let contentType: String
    }

    private let lock = NSLock()
    private let dateProvider: DateProvider
    private var rules: [CompiledRule] = []
    private var errorSimulation: CompiledErrorSimulation?

    init(dateProvider: DateProvider = SystemDateProvider()) {
        self.dateProvider = dateProvider
    }

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

        lock.lock()
        rules = compiled
        lock.unlock()
    }

    func setErrorSimulation(_ dto: NetworkErrorSimulationDTO) {
        lock.lock()
        defer { lock.unlock() }

        guard dto.enabled, let errorType = dto.errorType else {
            errorSimulation = nil
            return
        }

        errorSimulation = CompiledErrorSimulation(
            errorType: errorType,
            remaining: dto.limit,
            expiresAtEpochMs: dto.expiresAtEpochMs
        )
    }

    func activeErrorSimulation() -> ErrorSimulation? {
        lock.lock()
        defer { lock.unlock() }

        guard var simulation = errorSimulation else {
            return nil
        }

        if let expiresAtEpochMs = simulation.expiresAtEpochMs,
           currentEpochMs() >= expiresAtEpochMs
        {
            errorSimulation = nil
            return nil
        }

        if let remaining = simulation.remaining {
            guard remaining > 0 else {
                errorSimulation = nil
                return nil
            }
            simulation.remaining = remaining - 1
            errorSimulation = simulation.remaining == 0 ? nil : simulation
        }

        return ErrorSimulation(errorType: simulation.errorType)
    }

    func findMatchingRule(host: String, path: String, method: String) -> MatchedRule? {
        lock.lock()
        defer { lock.unlock() }

        for index in rules.indices {
            let rule = rules[index]
            if rule.method != "*", rule.method.caseInsensitiveCompare(method) != .orderedSame {
                continue
            }
            guard Self.matches(rule.host, host), Self.matches(rule.path, path) else {
                continue
            }
            if var remaining = rule.remaining {
                remaining -= 1
                rules[index].remaining = remaining
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

    private struct CompiledErrorSimulation {
        let errorType: String
        var remaining: Int?
        let expiresAtEpochMs: Int64?
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
