public protocol CommentRequirements {
    var value: Int {
        get /* setter is required */ set
    }
    var line: Int {
        get // getter comment
        set // setter comment
    }
    var block: Int {
        get /* setter
        is required */ set
    }
    var attributed: Int {
        @available(*, deprecated, message: "see http://x and /* text */") get
        /* setter */ set
    }
}
