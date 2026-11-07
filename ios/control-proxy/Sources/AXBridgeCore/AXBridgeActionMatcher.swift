public struct AXBridgeCandidate: Equatable, Sendable {
    public let identifier: String?
    public let description: String?
    public let rawActions: [String]

    public init(identifier: String?, description: String?, rawActions: [String]) {
        self.identifier = identifier
        self.description = description
        self.rawActions = rawActions
    }
}

public struct AXBridgeActionMatch: Equatable, Sendable {
    public let candidateIndex: Int
    public let rawAction: String
}

public enum AXBridgeActionMatcher {
    public static let contentGroupSubrole = "iOSContentGroup"

    /// Inspect a copy for matching; the original action string is always passed through untouched.
    public static func actionName(from rawAction: String) -> String? {
        rawAction.split(separator: "\n", omittingEmptySubsequences: false)
            .first(where: { $0.hasPrefix("Name:") })
            .map { String($0.dropFirst("Name:".count)) }
    }

    public static func identifies(_ candidate: AXBridgeCandidate, for request: AXBridgeRequest) -> Bool {
        let targets = [request.elementId, request.elementDesc].compactMap { $0 }.filter { !$0.isEmpty }
        return [candidate.identifier, candidate.description].compactMap { $0 }.contains { targets.contains($0) }
    }

    public static func match(
        in candidates: [AXBridgeCandidate],
        for request: AXBridgeRequest
    )
        throws(AXBridgeError) -> AXBridgeActionMatch
    {
        var foundElement = false
        for (index, candidate) in candidates.enumerated() where identifies(candidate, for: request) {
            foundElement = true
            if let rawAction = candidate.rawActions.first(where: { actionName(from: $0) == request.actionName }) {
                return AXBridgeActionMatch(candidateIndex: index, rawAction: rawAction)
            }
        }
        throw AXBridgeError(
            code: foundElement ? "action_not_found" : "element_not_found",
            message: foundElement
                ? "The identified element does not expose the exact custom action \(request.actionName)."
                : "No element matches elementId or elementDesc inside an iOSContentGroup."
        )
    }
}
