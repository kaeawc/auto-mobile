import Foundation

/// Presentation only: forced errors never enter checks-based validity or change events.
struct PrototypeFieldError: Equatable {
    let isError: Bool
    let message: String?

    static func resolve(forced: Bool, errorText: String?, checkMessage: String?, supportingText: String?) -> Self {
        Self(
            isError: forced || checkMessage != nil,
            message: forced ? (errorText ?? checkMessage ?? supportingText) : checkMessage
        )
    }

    static func shown(_ node: PrototypeNode, state: [String: JSONValue], shown: Set<String>) -> Self {
        let checkMessage = node.checkedKeys.lazy.filter { shown.contains($0) }.compactMap {
            PrototypeChecks.evaluate(state[$0], checks: node.checks ?? [], nodeType: node.type).firstFailingMessage
        }.first
        return resolve(
            forced: node.type == "textField" && node.errorWhen?.holds(state) == true,
            errorText: node.errorText,
            checkMessage: checkMessage,
            supportingText: node.supportingText
        )
    }
}
