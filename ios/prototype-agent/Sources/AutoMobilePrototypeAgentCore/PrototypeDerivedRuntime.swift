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
        if !changed.dataPointers.isEmpty || collectionChanged || derivedConditionChanged(changed) {
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

    private func derivedConditionChanged(_ changed: PrototypeDeriveChanges) -> Bool {
        let names = Set((derive ?? [:]).compactMap { name, entry in
            PrototypeDerive.affected(entry, changed: changed) ? name : nil
        })
        guard !names.isEmpty, let root = authoredRoot.objectFields else { return false }
        func usesChangedCondition(_ node: [String: JSONValue]) -> Bool {
            PrototypeDerivedValidator.conditionReads(node, path: "").derived.contains { names.contains($0.name) }
                || PrototypeStrictRepeats.children(node, path: "").contains { usesChangedCondition($0.value) }
        }
        return usesChangedCondition(root)
    }
}
