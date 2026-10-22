import Foundation

extension PrototypeContractValidator {
    static func primitive(_ value: JSONValue, rule: [String: JSONValue]) -> Bool {
        switch rule["kind"]?.stringValue {
        case "number":
            guard let number = value.numberValue else { return false }
            return number.isFinite && (rule["integer"] != .bool(true) || number.rounded() == number)
                && number >= (rule["min"]?.numberValue ?? -.infinity)
                && number <= (rule["max"]?.numberValue ?? .infinity)
        case "boolean": return value.boolValue != nil
        case "true": return value == .bool(true)
        case "scalar": return PrototypeDataValues.isScalar(value)
        case "enum":
            guard case let .array(options)? = rule["values"] else { return false }
            return options.contains(value)
        case "json":
            let cost = PrototypeLimits.dataByteCost(value, depth: 0)
            return cost != .max && Double(cost) <= (rule["maxBytes"]?.numberValue ?? .infinity)
        default:
            guard let text = value.stringValue else { return false }
            return textValid(text, rule: rule)
        }
    }

    private static func textValid(_ text: String, rule: [String: JSONValue]) -> Bool {
        switch rule["kind"]?.stringValue {
        case "key": return PrototypeRepeat.isFieldName(text)
        case "boundKey": return boundKey(text)
        case "pointer": return PrototypeDataPointer.isValid(text)
        case "color": return text.range(of: "^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$", options: .regularExpression) != nil
        case "string":
            // ECMAScript trim's whitespace set, including BOM and excluding U+0085.
            let blank =
                "^[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$"
            return (rule["empty"] == .bool(true) || !text.isEmpty)
                && (rule["nonblank"] != .bool(true) || text.range(of: blank, options: .regularExpression) == nil)
                && Double(text.utf16.count) >= (rule["min"]?.numberValue ?? 0)
                && Double(text.utf16.count) <= (rule["max"]?.numberValue ?? .infinity)
        default: return false
        }
    }

    private static func boundKey(_ text: String) -> Bool {
        if PrototypeRepeat.isFieldName(text) { return true }
        let units = Array(text.utf16)
        var index = 0
        var placeholders = 0
        while index < units.count {
            if units[index] == 123 {
                guard let end = units[(index + 1)...].firstIndex(of: 125) else { return false }
                let token = String(decoding: units[(index + 1) ..< end], as: UTF16.self)
                let parts = token.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
                guard token == "index" || (parts.count == 2 && parts.allSatisfy(PrototypeRepeat.isFieldName)) else {
                    return false
                }
                placeholders += 1
                index = end + 1
            } else {
                let unit = units[index]
                guard (65 ... 90).contains(unit) || (97 ... 122).contains(unit)
                    || (48 ... 57).contains(unit) || unit == 95 else { return false }
                index += 1
            }
        }
        return placeholders > 0
    }

    static func data(_ value: JSONValue) throws {
        guard let fields = value.objectFields else { throw invalid("data", "Expected object") }
        do { try PrototypeLimits.guardData(fields) }
        catch let DecodingError.dataCorrupted(context) {
            // The existing guard spells diagnostics as `path: message`.
            let description = context.debugDescription
            guard let separator = description.range(of: ": ", options: .backwards) else {
                throw invalid("data", description)
            }
            throw invalid(String(description[..<separator.lowerBound]), String(description[separator.upperBound...]))
        }
        if PrototypeLimits.dataByteCost(value, depth: 0) > PrototypeLimits.maxDataBytes {
            throw invalid("data", "Data byte limit exceeded")
        }
    }
}
