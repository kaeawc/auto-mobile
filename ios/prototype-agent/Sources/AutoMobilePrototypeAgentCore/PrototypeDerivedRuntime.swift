import Foundation

extension PrototypeSpec {
    /// Shared mapping seam for state edits and data writes, with an observer for deterministic tests.
    func replacingDerivedInputs(
        data: [String: JSONValue]?, state: [String: JSONValue], changed: PrototypeDeriveChanges,
        observer: PrototypeDeriveObserver? = nil
    )
        throws -> PrototypeSpec
    {
        let values = PrototypeDerive.evaluate(
            derive, data: data, state: state, previous: derivedValues, changed: changed, observer: observer
        )
        // Scalar state reads do not change the drawn tree: interpolation consumes the cache directly.
        let collectionChanged = (derive ?? [:]).values.contains {
            $0.collection != nil && PrototypeDerive.affected($0, changed: changed)
        }
        let rebuilt: PrototypeNode
        if !changed.dataPointers.isEmpty || collectionChanged {
            rebuilt = try Self.buildRoot(
                authoredRoot, data: data, menuState: state, strings: strings, locales: locales,
                platform: platformState, derive: derive, derivedValues: values, routes: routeScope
            )
            try PrototypeStacks.validate(root: rebuilt)
            try PrototypeThemeModes.validate(placement: window.placement, root: rebuilt)
        } else {
            rebuilt = root
        }
        var next = PrototypeSpec(replacing: self, data: data, root: rebuilt, derivedValues: values)
        next.derivedState = state
        return next
    }
}
