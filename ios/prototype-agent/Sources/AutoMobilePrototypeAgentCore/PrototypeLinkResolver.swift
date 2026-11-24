import Foundation

/// Registration guard; the matcher retains ownership of raw custom authority/path semantics.
enum PrototypeLinkResolver {
    struct Web { let scheme: String; let host: String }
    struct Registration { let schemes: [String]; var web: [Web] = [] }

    static func resolve(_ url: String, registration: Registration, entries: [PrototypeLinkMatcher.Entry])
        -> PrototypeLinkMatcher.Match?
    {
        guard let separator = url.range(of: "://"), separator.lowerBound != url.startIndex else { return nil }
        let scheme = url[..<separator.lowerBound].lowercased()
        if scheme == "http" || scheme == "https" {
            guard let parsed = URLComponents(string: url), let hostname = parsed.host,
                  parsed.user == nil, parsed.password == nil else { return nil }
            let port = parsed.port.flatMap { $0 == (scheme == "https" ? 443 : 80) ? nil : $0 }
            let host = hostname + (port.map { ":\($0)" } ?? "")
            guard registration.web.contains(where: {
                $0.scheme.lowercased() == scheme && $0.host.lowercased() == host.lowercased()
            }) else { return nil }
        } else if !registration.schemes.contains(where: { $0.lowercased() == scheme }) { return nil }
        return PrototypeLinkMatcher.match(url, entries: entries)
    }
}
