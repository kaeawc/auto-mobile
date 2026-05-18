#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Executes the given block, catching any NSException thrown.
/// Returns the caught NSException, or nil if no exception was raised.
FOUNDATION_EXPORT NSException * _Nullable ObjCExceptionCatcher_tryBlock(void (NS_NOESCAPE ^block)(void));

NS_ASSUME_NONNULL_END
