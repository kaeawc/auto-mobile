public func generic<T>(value: T)
where T: Equatable {}
public protocol Requirements {
    func requirement<T>(value: T)
    where   T: Equatable
}
public extension Requirements {
    func extended<T>(
        value: T
    )
    where T: Equatable {}
}
public func finalSignature()
