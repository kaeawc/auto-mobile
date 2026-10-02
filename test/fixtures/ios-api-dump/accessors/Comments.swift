public protocol CommentRequirements {
    var value: Int { get /* setter is required */ set }
    var line: Int { get /* inline equivalent */ set }
    var block: Int { get /* block equivalent */ set }
    var attributed: Int { @available(*, deprecated, message: "see http://x and /* text */") get /* setter */ set }
}
