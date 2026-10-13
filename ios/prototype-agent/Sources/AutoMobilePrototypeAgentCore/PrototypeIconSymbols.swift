/// The contract's icon styles. SF Symbols provide filled/outlined forms for some concepts.
enum PrototypeIconVariant: String, CaseIterable, Sendable {
    case filled, outlined, rounded, sharp, twoTone
}

/// What the renderer draws for an author-named icon.
enum PrototypeIconResolution: Equatable, Sendable {
    case symbol(String, fallback: String?)
    case placeholder
    case unknown
}

/// Compiled from the canonical table. The shared index is initialized lazily once by Swift.
struct PrototypeIconSymbolTable: Sendable {
    static let shared = PrototypeIconSymbolTable(data: prototypeIconSymbolData)

    private struct Entry: Sendable {
        let symbol: String
        let filled: String?
        let outlined: String?
    }

    private let entries: [String: Entry]
    private let unmapped: Set<String>
    let mappedNames: [String]
    let unmappedNames: [String]

    init(data: String) {
        var entries: [String: Entry] = [:]
        var mappedNames: [String] = []
        var unmappedNames: [String] = []
        for line in data.split(separator: "\n") {
            let fields = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard let name = fields.first, !name.isEmpty else { continue }
            if fields.count == 4, !fields[1].isEmpty {
                entries[name] = Entry(
                    symbol: fields[1],
                    filled: fields[2].isEmpty ? nil : fields[2],
                    outlined: fields[3].isEmpty ? nil : fields[3]
                )
                mappedNames.append(name)
            } else if fields.count == 1 {
                unmappedNames.append(name)
            }
        }
        self.entries = entries
        self.mappedNames = mappedNames
        self.unmappedNames = unmappedNames
        unmapped = Set(unmappedNames)
    }

    func resolve(_ name: String?, variant: String? = nil) -> PrototypeIconResolution {
        guard let name else { return .unknown }
        guard let entry = entries[name] else {
            return unmapped.contains(name) ? .placeholder : .unknown
        }
        let symbol: String
        switch variant {
        case "filled": symbol = entry.filled ?? entry.symbol
        case "outlined": symbol = entry.outlined ?? entry.symbol
        default: symbol = entry.symbol
        }
        return .symbol(symbol, fallback: symbol == entry.symbol ? nil : entry.symbol)
    }

    /// The symbol to draw: the chosen form if loadable, else the entry default, else the placeholder.
    /// The placeholder itself is returned without an availability check. Names outside the contract
    /// return nil.
    func symbolName(for name: String?, variant: String? = nil, isAvailable: (String) -> Bool) -> String? {
        switch resolve(name, variant: variant) {
        case .unknown: return nil
        case .placeholder: return prototypeIconSymbolPlaceholder
        case let .symbol(symbol, fallback):
            if isAvailable(symbol) { return symbol }
            if let fallback, isAvailable(fallback) { return fallback }
            return prototypeIconSymbolPlaceholder
        }
    }
}
