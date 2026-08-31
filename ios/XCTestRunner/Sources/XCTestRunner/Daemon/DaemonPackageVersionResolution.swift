/// The result of resolving a daemon package-version pin into a `<package>@<version>` specifier.
enum DaemonPackageVersionResolution: Equatable, Sendable {
    case absent
    case valid(String)
    case invalid(String)
}
