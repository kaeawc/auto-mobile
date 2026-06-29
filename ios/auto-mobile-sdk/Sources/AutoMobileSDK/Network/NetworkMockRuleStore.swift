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

final class NetworkMockRuleStore: @unchecked Sendable {
    static let shared = NetworkMockRuleStore()

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
    private var rules: [CompiledRule] = []

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

    private static func matches(_ regex: NSRegularExpression, _ value: String) -> Bool {
        let range = NSRange(value.startIndex ..< value.endIndex, in: value)
        return regex.firstMatch(in: value, range: range) != nil
    }
}
