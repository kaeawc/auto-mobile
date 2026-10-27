import Foundation

enum PrototypeValidateOn: String, Decodable {
    case change, blur, submit
}

/// Typed decoding follows neighbouring node fields: unknown members are ignored. The host owns
/// grammar, kind/control compatibility and reference validation; the agent only backs up limits.
struct PrototypeCheck: Decodable, Equatable {
    let message: String
    let required: Bool?
    let minLength: Int?
    let maxLength: Int?
    let pattern: String?
    let format: String?
    let min: Double?
    let max: Double?
}

struct PrototypeCheckEvaluation: Decodable, Equatable {
    let valid: Bool
    let firstFailingMessage: String?
}

struct PrototypeCheckBinding: Equatable {
    let key: String
    let nodeType: String
    let checks: [PrototypeCheck]
}

/// Bound once after repeat expansion. Conditions carry only immutable check definitions, so all
/// existing holds(state) consumers (including appearance and anchors) derive fresh validity.
final class PrototypeValidityContext: Equatable {
    var bindings: [PrototypeCheckBinding] = []

    static func == (lhs: PrototypeValidityContext, rhs: PrototypeValidityContext) -> Bool {
        lhs.bindings == rhs.bindings
    }

    func holds(_ keys: [String], state: [String: JSONValue]) -> Bool {
        let validity = PrototypeChecks.validity(bindings, state: state)
        return keys.allSatisfy { validity[$0] == true }
    }
}

enum PrototypeChecks {
    /// ECMAScript whitespace, deliberately distinct from the pattern grammar's ASCII whitespace.
    private static let whitespace =
        "\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"

    static func formatPasses(_ value: String, format: String, maxLength: Int? = nil) -> Bool {
        let nonspace = "[^\(whitespace)"
        let pattern: String
        switch format {
        case "email": pattern = "\(nonspace)@]+@\(nonspace)@]+\\.\(nonspace)@]+"
        case "phone": pattern = "\\+?[0-9 ()-]{7,15}"
        case "digits": pattern = "[0-9]+"
        case "decimal": pattern = "-?[0-9]+(\\.[0-9]+)?"
        case "url": pattern = "https?://\(nonspace)/?#]+([/?#]\(nonspace)]*)?"
        default: return false
        }
        return PrototypeCheckPattern.wholeMatch(pattern, value, maxLength: maxLength)
            && (
                format != "phone" || value.utf16.prefix(maxLength ?? value.utf16.count)
                    .filter { (48 ... 57).contains($0) }.count >= 7
            )
    }

    static func evaluate(_ value: JSONValue?, checks: [PrototypeCheck], nodeType: String) -> PrototypeCheckEvaluation {
        let failed = checks.first { !passes(value, check: $0, nodeType: nodeType) }
        return PrototypeCheckEvaluation(valid: failed == nil, firstFailingMessage: failed?.message)
    }

    private static func requiredPasses(_ value: JSONValue?, nodeType: String) -> Bool {
        switch nodeType {
        case "checkbox", "switch": return value == .bool(true)
        case "slider", "timePicker": return value?.numberValue?.isFinite == true
        default:
            guard let text = value?.stringValue else { return false }
            return !PrototypeContractValidator.matches("blankText", text)
        }
    }

    private static func passes(_ value: JSONValue?, check: PrototypeCheck, nodeType: String) -> Bool {
        if check.required != nil {
            return requiredPasses(value, nodeType: nodeType)
        }
        if value == nil || value == .null || value == .string("") {
            return true
        }
        let text = value?.stringValue ?? ""
        if let min = check.minLength {
            return text.utf16.count >= min
        }
        if let max = check.maxLength {
            return text.utf16.count <= max
        }
        if let pattern = check.pattern {
            return PrototypeCheckPattern.matches(pattern, text)
        }
        if let format = check.format {
            return formatPasses(text, format: format, maxLength: PrototypeCheckPattern.maxValueLength)
        }
        let number = nodeType == "datePicker" ? textDate(text) : value?.numberValue
        guard let number, number.isFinite else { return false }
        if let min = check.min {
            return number >= min
        }
        if let max = check.max {
            return number <= max
        }
        return false
    }

    /// Date.parse accepts overflow days in a valid month. Gregorian UTC arithmetic also avoids
    /// locale, timezone and wall-clock dependencies, including for year zero.
    private static func textDate(_ text: String) -> Double? {
        guard PrototypeCheckPattern.wholeMatch("[0-9]{4}-[0-9]{2}-[0-9]{2}", text) else { return nil }
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, (1 ... 12).contains(parts[1]), (1 ... 31).contains(parts[2]) else { return nil }
        let year = parts[0] - (parts[1] <= 2 ? 1 : 0)
        let era = Int(floor(Double(year) / 400))
        let yearOfEra = year - era * 400
        let month = parts[1] + (parts[1] > 2 ? -3 : 9)
        let dayOfYear = (153 * month + 2) / 5 + parts[2] - 1
        let days = era * 146_097 + yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear - 719_468
        return Double(days) * 86_400_000
    }

    static func bindings(root: PrototypeNode) -> [PrototypeCheckBinding] {
        let own = (root.checks?.isEmpty == false) ? root.checkedKeys.map {
            PrototypeCheckBinding(key: $0, nodeType: root.type, checks: root.checks ?? [])
        } : []
        return own + root.childEntries(path: "root").flatMap { bindings(root: $0.node) }
    }

    static func validity(_ bindings: [PrototypeCheckBinding], state: [String: JSONValue]) -> [String: Bool] {
        bindings.reduce(into: [:]) { result, binding in
            let valid = evaluate(state[binding.key], checks: binding.checks, nodeType: binding.nodeType).valid
            result[binding.key] = (result[binding.key] ?? true) && valid
        }
    }
}

extension Condition {
    func bindValidity(_ bindings: [PrototypeCheckBinding]) {
        switch self {
        case let .valid(_, context): context.bindings = bindings
        case let .all(conditions), let .any(conditions): conditions.forEach { $0.bindValidity(bindings) }
        case let .not(condition): condition.bindValidity(bindings)
        default: break
        }
    }
}

extension PrototypeNode {
    var checkedKeys: [String] {
        [stateKey, hourKey, minuteKey].compactMap { $0 }
    }

    func bindValidity(_ bindings: [PrototypeCheckBinding]) {
        visibleWhen?.bindValidity(bindings)
        enabledWhen?.bindValidity(bindings)
        errorWhen?.bindValidity(bindings)
        openWhen?.bindValidity(bindings)
        styleWhen?.forEach { $0.when.bindValidity(bindings) }
        childEntries(path: "root").forEach { $0.node.bindValidity(bindings) }
    }
}
