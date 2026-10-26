import Foundation

/// Semantic backstop shared by strict imports and the decoder; formatting remains a runtime concern.
enum PrototypeDerivedValidator {
    static func validate(derive: JSONValue?, root: JSONValue, data: [String: JSONValue]?) throws {
        let entries = derive?.objectFields ?? [:]
        try fractions(entries, path: "derive")
        try visit(root, path: "root", entries: entries, data: data)
    }

    private static func fractions(_ entries: [String: JSONValue], path: String) throws {
        for name in PrototypeContractValidator.sorted(entries.keys) {
            for kind in ["number", "percent"] {
                let options = entries[name]?.objectFields?["format"]?.objectFields?[kind]?.objectFields
                if let minimum = options?["minFraction"]?.numberValue,
                   let maximum = options?["maxFraction"]?.numberValue, minimum > maximum
                {
                    throw PrototypeContractValidator.invalid(
                        "\(path).\(name).format.\(kind).minFraction",
                        "minFraction cannot exceed maxFraction"
                    )
                }
            }
        }
    }

    private static func visit(
        _ root: JSONValue, path: String, entries: [String: JSONValue], data: [String: JSONValue]?
    )
        throws
    {
        guard let fields = root.objectFields else { return }
        // Reuse the text-field mapper, so payloads, action operands and child nodes remain opaque.
        var textFields = fields
        PrototypeRepeat.bindTextFields(&textFields) { _ in "" }
        try reads(.object(fields), mapped: .object(textFields), path: path, entries: entries)
        if let repeated = fields["repeat"]?.objectFields, let derived = repeated["derive"]?.objectFields {
            let derivePath = "\(path).repeat.derive"
            try fractions(derived, path: derivePath)
            let source = repeated["items"]
            let items: JSONValue?
            if let pointer = source?.objectFields?["path"]?.stringValue {
                items = PrototypeDataPointer.resolve(data, pointer: pointer)
            } else { items = source }
            if case let .array(rows)? = items {
                for name in PrototypeContractValidator.sorted(derived.keys)
                    where rows.contains(where: { $0.objectFields?[name] != nil })
                {
                    throw PrototypeContractValidator.invalid(
                        "\(derivePath).\(name)",
                        "Derived name collides with an item field"
                    )
                }
            }
        }
        for child in PrototypeStrictRepeats.children(fields, path: path) {
            try visit(.object(child.value), path: child.path, entries: entries, data: data)
        }
    }

    private static func reads(
        _ original: JSONValue, mapped: JSONValue, path: String, entries: [String: JSONValue]
    )
        throws
    {
        guard original != mapped else { return }
        switch (original, mapped) {
        case let (.string(text), .string):
            for span in PrototypeDerivedText.spans(text) where entries[span.name] == nil {
                throw PrototypeContractValidator.invalid(
                    path,
                    "Unknown derived value \(PrototypeContractValidator.quoted(span.name))"
                )
            }
        case let (.object(fields), .object(mappedFields)):
            for key in PrototypeContractValidator.sorted(fields.keys) {
                if let value = fields[key], let mapped = mappedFields[key] {
                    try reads(
                        value,
                        mapped: mapped,
                        path: PrototypeContractValidator.keyPath(path, key),
                        entries: entries
                    )
                }
            }
        case let (.array(items), .array(mappedItems)):
            for (index, pair) in zip(items, mappedItems).enumerated() {
                try reads(pair.0, mapped: pair.1, path: "\(path)[\(index)]", entries: entries)
            }
        default: break
        }
    }
}

enum PrototypeDerivedText {
    struct Span {
        let start: Int
        let end: Int
        let name: String
    }

    /// UTF-16 offsets, like the data and repeat scanners. Malformed placeholders remain literal.
    static func spans(_ text: String) -> [Span] {
        let units = Array(text.utf16)
        let prefix = Array("{derived:".utf16)
        var result: [Span] = []
        var index = 0
        while index < units.count {
            if units[index...].starts(with: prefix),
               let close = units[(index + prefix.count) ..< min(units.count, index + prefix.count + 65)]
               .firstIndex(of: 125)
            {
                let name = String(decoding: units[(index + prefix.count) ..< close], as: UTF16.self)
                if PrototypeRepeat.isFieldName(name) {
                    result.append(Span(start: index, end: close + 1, name: name))
                    index = close + 1
                    continue
                }
            }
            index += 1
        }
        return result
    }
}
