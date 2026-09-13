import Foundation
import Security

public enum ProbeSigning {
    public static let controllerIdentifier = "dev.jasonpearson.automobile.networkfilter"
    public static let providerIdentifier = "dev.jasonpearson.automobile.networkfilter.provider"

    /// Derive the team from our signed code, never a caller-supplied PID or plist.
    public static func peerRequirement(identifier: String) -> String? {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) ==
            errSecSuccess,
            let metadata = information as? [String: Any],
            let team = metadata[kSecCodeInfoTeamIdentifier as String] as? String,
            team.count == 10,
            team.utf8.allSatisfy({ (48 ... 57).contains($0) || (65 ... 90).contains($0) }),
            [controllerIdentifier, providerIdentifier].contains(identifier)
        else { return nil }
        return "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(team)\""
    }
}

public struct SecurityProbeIdentityResolver: ProbeIdentityResolver {
    public init() {}

    public func resolve(auditToken: Data) -> ProbeCodeIdentity? {
        guard auditToken.count == 32 else { return nil }
        var code: SecCode?
        let attributes = [kSecGuestAttributeAudit as String: auditToken] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
              let code,
              SecCodeCheckValidity(code, [], nil) == errSecSuccess
        else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) ==
            errSecSuccess,
            let metadata = information as? [String: Any]
        else { return nil }
        return ProbeCodeIdentity(
            signingIdentifier: metadata[kSecCodeInfoIdentifier as String] as? String,
            teamIdentifier: metadata[kSecCodeInfoTeamIdentifier as String] as? String,
            executablePath: (metadata[kSecCodeInfoMainExecutable as String] as? URL)?.path
        )
    }
}
