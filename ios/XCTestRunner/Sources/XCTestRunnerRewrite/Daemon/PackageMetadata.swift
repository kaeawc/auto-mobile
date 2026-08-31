/// The one `package.json` field the repo-root discovery needs — the package name — so a runner
/// vendored inside a host JavaScript project doesn't mistake that project for the AutoMobile checkout.
struct PackageMetadata: Decodable, Sendable {
    let name: String?
}
