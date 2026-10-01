#if DEBUG && !os(watchOS)
    import Foundation

    struct ResolvedStore: Equatable {
        let suiteName: String?
        var label: String { suiteName ?? "standard" }
    }

    struct UserDefaultsStoreResolver {
        let bundleIdentifier: String?
        let suiteIsValid: (String) -> Bool
        static let defaultSuiteIsValid: (String) -> Bool = { UserDefaults(suiteName: $0) != nil }

        /// A nil resolution means Foundation rejected the suite name.
        func resolve(_ name: String) -> ResolvedStore? {
            guard name == name.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
            if name.isEmpty || name.caseInsensitiveCompare("standard") == .orderedSame {
                return ResolvedStore(suiteName: nil)
            }
            if let bundleIdentifier, !bundleIdentifier.isEmpty,
               name.caseInsensitiveCompare(bundleIdentifier) == .orderedSame
            {
                return ResolvedStore(suiteName: nil)
            }
            return suiteIsValid(name) ? ResolvedStore(suiteName: name) : nil
        }
    }
#endif
