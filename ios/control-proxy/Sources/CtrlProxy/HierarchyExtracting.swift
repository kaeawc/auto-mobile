import Foundation

@MainActor
protocol HierarchyExtracting {
    func getViewHierarchy(disableAllFiltering: Bool) throws -> ViewHierarchy
}
