/// Per-prototype direction. An absent value inherits the host without changing its locale.
enum PrototypeLayoutDirection: String, Decodable {
    case ltr, rtl

    static func resolve(_ authored: Self?, host: Self) -> Self {
        authored ?? host
    }
}
