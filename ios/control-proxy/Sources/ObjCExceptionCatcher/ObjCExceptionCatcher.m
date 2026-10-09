#import "ObjCExceptionCatcher.h"
#import <math.h>
#import <stdbool.h>

ObjCPinchPoints ObjCExceptionCatcher_computePinchPoints(
    CGFloat centerX,
    CGFloat centerY,
    CGFloat distanceStart,
    CGFloat distanceEnd,
    CGFloat rotationDegrees
) {
    CGFloat startRadius = distanceStart / 2.0;
    CGFloat endRadius = distanceEnd / 2.0;
    // rotationDegrees rotates the finger axis *during* the pinch, NOT the orientation of a fixed
    // pinch axis: the fingers start on the horizontal axis (dyStart == 0) and move to an axis
    // rotated by rotationDegrees. A non-zero value therefore produces a combined pinch+rotate;
    // rotationDegrees == 0 (the common zoom case) keeps both axes horizontal. This matches the
    // Android runner's computePinchPoints so cross-platform results agree. See issues #2911/#2979.
    CGFloat endRadians = rotationDegrees * (CGFloat)M_PI / 180.0;
    CGFloat dxStart = startRadius;
    CGFloat dyStart = 0;
    CGFloat dxEnd = cos(endRadians) * endRadius;
    CGFloat dyEnd = sin(endRadians) * endRadius;

    ObjCPinchPoints points;
    points.start1 = CGPointMake(centerX - dxStart, centerY - dyStart);
    points.end1 = CGPointMake(centerX - dxEnd, centerY - dyEnd);
    points.start2 = CGPointMake(centerX + dxStart, centerY + dyStart);
    points.end2 = CGPointMake(centerX + dxEnd, centerY + dyEnd);
    return points;
}

NSException * _Nullable ObjCExceptionCatcher_tryBlock(void (NS_NOESCAPE ^block)(void)) {
    @try {
        block();
        return nil;
    }
    @catch (NSException *exception) {
        return exception;
    }
}

BOOL ObjCExceptionCatcher_synthesizeMultiFingerSwipe(
    CGFloat startX,
    CGFloat startY,
    CGFloat endX,
    CGFloat endY,
    NSInteger fingerCount,
    CGFloat fingerSpacing,
    NSTimeInterval duration,
    NSInteger interfaceOrientation,
    BOOL *_Nullable symbolsUnavailable,
    NSString *_Nullable *_Nullable errorMessage
) {
    // Default: symbols are assumed present until a guard proves otherwise, so a
    // genuine synthesis error is not misreported as an availability gap.
    if (symbolsUnavailable != NULL) {
        *symbolsUnavailable = NO;
    }
#if TARGET_OS_IOS
    __block BOOL success = NO;
    __block NSString *failure = nil;
    __block BOOL unavailable = NO;

    NSException *exception = ObjCExceptionCatcher_tryBlock(^{
        Class pathClass = NSClassFromString(@"XCPointerEventPath");
        Class recordClass = NSClassFromString(@"XCSynthesizedEventRecord");

        if (pathClass == Nil || recordClass == Nil) {
            unavailable = YES;
            failure = @"XCTest private multi-touch event synthesis classes are unavailable";
            return;
        }
        if (![pathClass instancesRespondToSelector:@selector(initForTouchAtPoint:offset:)] ||
            ![pathClass instancesRespondToSelector:@selector(moveToPoint:atOffset:)] ||
            ![pathClass instancesRespondToSelector:@selector(liftUpAtOffset:)]) {
            unavailable = YES;
            failure = @"XCPointerEventPath does not support the expected multi-touch selectors";
            return;
        }
        if (![recordClass instancesRespondToSelector:@selector(initWithName:interfaceOrientation:)] ||
            ![recordClass instancesRespondToSelector:@selector(addPointerEventPath:)] ||
            ![recordClass instancesRespondToSelector:@selector(synthesizeWithError:)]) {
            unavailable = YES;
            failure = @"XCSynthesizedEventRecord does not support the expected synthesis selectors";
            return;
        }

        XCSynthesizedEventRecord *record = [[recordClass alloc]
            initWithName:@"AutoMobile multi-finger swipe"
            interfaceOrientation:(UIInterfaceOrientation)interfaceOrientation
        ];
        NSInteger resolvedFingerCount = fingerCount > 1 ? fingerCount : 1;
        NSTimeInterval liftOffset = duration > 0.05 ? duration : 0.05;

        for (NSInteger index = 0; index < resolvedFingerCount; index++) {
            CGFloat dx = (CGFloat)index * fingerSpacing;
            XCPointerEventPath *path = [[pathClass alloc]
                initForTouchAtPoint:CGPointMake(startX + dx, startY)
                offset:0
            ];
            [path moveToPoint:CGPointMake(endX + dx, endY) atOffset:duration];
            [path liftUpAtOffset:liftOffset];
            [record addPointerEventPath:path];
        }

        NSError *synthesisError = nil;
        success = [record synthesizeWithError:&synthesisError];
        if (!success) {
            NSString *description = synthesisError.localizedDescription != nil ? synthesisError.localizedDescription : @"unknown error";
            failure = [NSString stringWithFormat:@"multi-finger swipe synthesis failed: %@",
                       description];
        }
    });

    if (exception != nil) {
        // A caught exception is a genuine synthesis failure, not an availability
        // gap, so leave `unavailable` as-is (NO unless a guard already set it).
        NSString *reason = exception.reason != nil ? exception.reason : @"no reason";
        failure = [NSString stringWithFormat:@"Objective-C exception during multi-finger swipe synthesis: %@ - %@",
                   exception.name, reason];
    }
    if (!success) {
        if (symbolsUnavailable != NULL) {
            *symbolsUnavailable = unavailable;
        }
        if (errorMessage != NULL) {
            *errorMessage = failure != nil ? failure : @"multi-finger swipe synthesis failed";
        }
    }

    return success;
#else
    // Off-iOS the private symbols are definitionally unavailable. There is no
    // public-API fallback for a multi-finger swipe, so this only selects the
    // availability-flavored failure message (see MultiFingerSwipeDiagnostics).
    if (symbolsUnavailable != NULL) {
        *symbolsUnavailable = YES;
    }
    if (errorMessage != NULL) {
        *errorMessage = @"XCTest private multi-touch event synthesis is only available on iOS";
    }
    return NO;
#endif
}

BOOL ObjCExceptionCatcher_synthesizePinch(
    CGFloat centerX,
    CGFloat centerY,
    CGFloat distanceStart,
    CGFloat distanceEnd,
    CGFloat rotationDegrees,
    NSTimeInterval duration,
    NSInteger interfaceOrientation,
    BOOL *_Nullable symbolsUnavailable,
    NSString *_Nullable *_Nullable errorMessage
) {
    // Default: symbols are assumed present until a guard proves otherwise, so a
    // genuine synthesis error is not misreported as an availability gap.
    if (symbolsUnavailable != NULL) {
        *symbolsUnavailable = NO;
    }
#if TARGET_OS_IOS
    __block BOOL success = NO;
    __block NSString *failure = nil;
    __block BOOL unavailable = NO;

    NSException *exception = ObjCExceptionCatcher_tryBlock(^{
        Class pathClass = NSClassFromString(@"XCPointerEventPath");
        Class recordClass = NSClassFromString(@"XCSynthesizedEventRecord");

        if (pathClass == Nil || recordClass == Nil) {
            unavailable = YES;
            failure = @"XCTest private pinch event synthesis classes are unavailable";
            return;
        }
        if (![pathClass instancesRespondToSelector:@selector(initForTouchAtPoint:offset:)] ||
            ![pathClass instancesRespondToSelector:@selector(moveToPoint:atOffset:)] ||
            ![pathClass instancesRespondToSelector:@selector(liftUpAtOffset:)]) {
            unavailable = YES;
            failure = @"XCPointerEventPath does not support the expected pinch selectors";
            return;
        }
        if (![recordClass instancesRespondToSelector:@selector(initWithName:interfaceOrientation:)] ||
            ![recordClass instancesRespondToSelector:@selector(addPointerEventPath:)] ||
            ![recordClass instancesRespondToSelector:@selector(synthesizeWithError:)]) {
            unavailable = YES;
            failure = @"XCSynthesizedEventRecord does not support the expected pinch synthesis selectors";
            return;
        }

        // Floor degenerate distances so a tiny/zero pinch still produces a non-collapsed radius.
        // The endpoint trig itself lives in the pure, unit-tested ObjCExceptionCatcher_computePinchPoints
        // (see PinchGeometryTests / issue #2979), which the Android computePinchPoints mirrors.
        CGFloat safeDistanceStart = distanceStart > 1 ? distanceStart : 1;
        CGFloat safeDistanceEnd = distanceEnd > 1 ? distanceEnd : 1;
        ObjCPinchPoints points = ObjCExceptionCatcher_computePinchPoints(
            centerX, centerY, safeDistanceStart, safeDistanceEnd, rotationDegrees);

        XCSynthesizedEventRecord *record = [[recordClass alloc]
            initWithName:@"AutoMobile pinch"
            interfaceOrientation:(UIInterfaceOrientation)interfaceOrientation
        ];
        NSTimeInterval liftOffset = duration > 0.05 ? duration : 0.05;

        XCPointerEventPath *firstPath = [[pathClass alloc]
            initForTouchAtPoint:points.start1
            offset:0
        ];
        [firstPath moveToPoint:points.end1 atOffset:duration];
        [firstPath liftUpAtOffset:liftOffset];
        [record addPointerEventPath:firstPath];

        XCPointerEventPath *secondPath = [[pathClass alloc]
            initForTouchAtPoint:points.start2
            offset:0
        ];
        [secondPath moveToPoint:points.end2 atOffset:duration];
        [secondPath liftUpAtOffset:liftOffset];
        [record addPointerEventPath:secondPath];

        NSError *synthesisError = nil;
        success = [record synthesizeWithError:&synthesisError];
        if (!success) {
            NSString *description = synthesisError.localizedDescription != nil ? synthesisError.localizedDescription : @"unknown error";
            failure = [NSString stringWithFormat:@"pinch synthesis failed: %@",
                       description];
        }
    });

    if (exception != nil) {
        // A caught exception is a genuine synthesis failure, not an availability
        // gap, so leave `unavailable` as-is (NO unless a guard already set it).
        NSString *reason = exception.reason != nil ? exception.reason : @"no reason";
        failure = [NSString stringWithFormat:@"Objective-C exception during pinch synthesis: %@ - %@",
                   exception.name, reason];
    }
    if (!success) {
        if (symbolsUnavailable != NULL) {
            *symbolsUnavailable = unavailable;
        }
        if (errorMessage != NULL) {
            *errorMessage = failure != nil ? failure : @"pinch synthesis failed";
        }
    }

    return success;
#else
    // Off-iOS the private symbols are definitionally unavailable, so signal the
    // caller to take the public-API fallback path.
    if (symbolsUnavailable != NULL) {
        *symbolsUnavailable = YES;
    }
    if (errorMessage != NULL) {
        *errorMessage = @"XCTest private pinch event synthesis is only available on iOS";
    }
    return NO;
#endif
}

NSNumber * _Nullable ObjCExceptionCatcher_displayID(NSObject *object) {
    __block NSNumber *result = nil;
    NSException *exception = ObjCExceptionCatcher_tryBlock(^{
        SEL selector = NSSelectorFromString(@"displayID");
        if ([object respondsToSelector:selector]) {
            long long (*read)(id, SEL) = (long long (*)(id, SEL))[object methodForSelector:selector];
            result = @(read(object, selector));
        }
    });
    return exception == nil ? result : nil;
}

NSArray<NSDictionary<NSString *, NSNumber *> *> * _Nullable ObjCExceptionCatcher_displayInventory(void) {
#if TARGET_OS_IOS
    __block NSMutableArray<NSDictionary<NSString *, NSNumber *> *> *result = [NSMutableArray array];
    NSException *exception = ObjCExceptionCatcher_tryBlock(^{
        Class screenClass = NSClassFromString(@"XCUIScreen");
        SEL screensSelector = NSSelectorFromString(@"screens");
        if (screenClass == Nil || ![screenClass respondsToSelector:screensSelector]) { return; }
        id (*readScreens)(id, SEL) = (id (*)(id, SEL))[screenClass methodForSelector:screensSelector];
        id screens = readScreens(screenClass, screensSelector);
        if (![screens isKindOfClass:[NSArray class]]) { return; }
        for (NSObject *screen in screens) {
            // Catch per-screen failures so later inventory entries can still be sampled.
            ObjCExceptionCatcher_tryBlock(^{
                NSNumber *displayID = ObjCExceptionCatcher_displayID(screen);
                SEL mainSelector = NSSelectorFromString(@"isMainScreen");
                if (displayID == nil || ![screen respondsToSelector:mainSelector]) { return; }
                bool (*readMain)(id, SEL) = (bool (*)(id, SEL))[screen methodForSelector:mainSelector];
                [result addObject:@{@"displayId": displayID, @"isMain": @(readMain(screen, mainSelector))}];
            });
        }
    });
    return exception == nil ? result : nil;
#else
    return nil;
#endif
}

BOOL ObjCExceptionCatcher_synthesizeDisplayTouch(
    CGFloat startX, CGFloat startY, CGFloat endX, CGFloat endY,
    NSTimeInterval pressDuration, NSTimeInterval moveDuration, NSTimeInterval holdDuration,
    unsigned long long displayID, NSInteger interfaceOrientation,
    BOOL *_Nullable symbolsUnavailable, NSString *_Nullable *_Nullable errorMessage
) {
    if (symbolsUnavailable != NULL) { *symbolsUnavailable = NO; }
#if TARGET_OS_IOS
    __block BOOL success = NO;
    __block BOOL unavailable = NO;
    __block NSString *failure = nil;
    NSException *exception = ObjCExceptionCatcher_tryBlock(^{
        Class pathClass = NSClassFromString(@"XCPointerEventPath");
        Class recordClass = NSClassFromString(@"XCSynthesizedEventRecord");
        if (pathClass == Nil || recordClass == Nil ||
            ![pathClass instancesRespondToSelector:@selector(initForTouchAtPoint:offset:)] ||
            ![pathClass instancesRespondToSelector:@selector(moveToPoint:atOffset:)] ||
            ![pathClass instancesRespondToSelector:@selector(liftUpAtOffset:)] ||
            ![recordClass instancesRespondToSelector:@selector(initWithName:displayID:interfaceOrientation:)] ||
            ![recordClass instancesRespondToSelector:@selector(addPointerEventPath:)] ||
            ![recordClass instancesRespondToSelector:@selector(synthesizeWithError:)]) {
            unavailable = YES;
            failure = @"XCTest private display-targeted event synthesis symbols are unavailable";
            return;
        }
        XCSynthesizedEventRecord *record = [[recordClass alloc]
            initWithName:@"AutoMobile display-targeted touch"
            displayID:displayID interfaceOrientation:(UIInterfaceOrientation)interfaceOrientation];
        XCPointerEventPath *path = [[pathClass alloc]
            initForTouchAtPoint:CGPointMake(startX, startY) offset:0];
        NSTimeInterval press = pressDuration > 0 ? pressDuration : 0;
        NSTimeInterval move = moveDuration > 0 ? moveDuration : 0;
        NSTimeInterval hold = holdDuration > 0 ? holdDuration : 0;
        if (move > 0 || startX != endX || startY != endY) {
            if (press > 0) { [path moveToPoint:CGPointMake(startX, startY) atOffset:press]; }
            [path moveToPoint:CGPointMake(endX, endY) atOffset:press + move];
            if (hold > 0) { [path moveToPoint:CGPointMake(endX, endY) atOffset:press + move + hold]; }
        }
        NSTimeInterval held = press + move + hold;
        NSTimeInterval liftOffset = held > 0.05 ? held : 0.05;
        [path liftUpAtOffset:liftOffset];
        [record addPointerEventPath:path];
        NSError *synthesisError = nil;
        success = [record synthesizeWithError:&synthesisError];
        if (!success) {
            NSString *description = synthesisError.localizedDescription != nil ? synthesisError.localizedDescription : @"unknown error";
            failure = [NSString stringWithFormat:@"display-targeted touch synthesis failed: %@",
                description];
        }
    });
    if (exception != nil) {
        NSString *reason = exception.reason != nil ? exception.reason : @"no reason";
        failure = [NSString stringWithFormat:@"Objective-C exception during display-targeted touch synthesis: %@ - %@",
            exception.name, reason];
    }
    if (symbolsUnavailable != NULL) { *symbolsUnavailable = unavailable; }
    if (!success && errorMessage != NULL) { *errorMessage = failure != nil ? failure : @"display-targeted touch synthesis failed"; }
    return success;
#else
    if (symbolsUnavailable != NULL) { *symbolsUnavailable = YES; }
    if (errorMessage != NULL) { *errorMessage = @"XCTest private display-targeted synthesis is only available on iOS"; }
    return NO;
#endif
}

BOOL ObjCExceptionCatcher_synthesizeDisplayPinch(
    ObjCPinchPoints points, NSTimeInterval duration,
    unsigned long long displayID, NSInteger interfaceOrientation,
    BOOL *_Nullable symbolsUnavailable, NSString *_Nullable *_Nullable errorMessage
) {
    if (symbolsUnavailable != NULL) { *symbolsUnavailable = NO; }
#if TARGET_OS_IOS
    __block BOOL success = NO;
    __block BOOL unavailable = NO;
    __block NSString *failure = nil;
    NSException *exception = ObjCExceptionCatcher_tryBlock(^{
        Class pathClass = NSClassFromString(@"XCPointerEventPath");
        Class recordClass = NSClassFromString(@"XCSynthesizedEventRecord");
        if (pathClass == Nil || recordClass == Nil ||
            ![pathClass instancesRespondToSelector:@selector(initForTouchAtPoint:offset:)] ||
            ![pathClass instancesRespondToSelector:@selector(moveToPoint:atOffset:)] ||
            ![pathClass instancesRespondToSelector:@selector(liftUpAtOffset:)] ||
            ![recordClass instancesRespondToSelector:@selector(initWithName:displayID:interfaceOrientation:)] ||
            ![recordClass instancesRespondToSelector:@selector(addPointerEventPath:)] ||
            ![recordClass instancesRespondToSelector:@selector(synthesizeWithError:)]) {
            unavailable = YES;
            failure = @"XCTest private display-targeted pinch synthesis symbols are unavailable";
            return;
        }
        XCSynthesizedEventRecord *record = [[recordClass alloc]
            initWithName:@"AutoMobile display-targeted pinch"
            displayID:displayID interfaceOrientation:(UIInterfaceOrientation)interfaceOrientation];
        // Same timing as the main-screen pinch: both fingers move for the duration, then lift.
        NSTimeInterval move = duration > 0 ? duration : 0;
        NSTimeInterval liftOffset = move > 0.05 ? move : 0.05;
        CGPoint starts[2] = {points.start1, points.start2};
        CGPoint ends[2] = {points.end1, points.end2};
        for (int index = 0; index < 2; index++) {
            XCPointerEventPath *path = [[pathClass alloc] initForTouchAtPoint:starts[index] offset:0];
            [path moveToPoint:ends[index] atOffset:move];
            [path liftUpAtOffset:liftOffset];
            [record addPointerEventPath:path];
        }
        NSError *synthesisError = nil;
        success = [record synthesizeWithError:&synthesisError];
        if (!success) {
            NSString *description = synthesisError.localizedDescription != nil ? synthesisError.localizedDescription : @"unknown error";
            failure = [NSString stringWithFormat:@"display-targeted pinch synthesis failed: %@", description];
        }
    });
    if (exception != nil) {
        NSString *reason = exception.reason != nil ? exception.reason : @"no reason";
        failure = [NSString stringWithFormat:@"Objective-C exception during display-targeted pinch synthesis: %@ - %@",
            exception.name, reason];
    }
    if (symbolsUnavailable != NULL) { *symbolsUnavailable = unavailable; }
    if (!success && errorMessage != NULL) { *errorMessage = failure != nil ? failure : @"display-targeted pinch synthesis failed"; }
    return success;
#else
    if (symbolsUnavailable != NULL) { *symbolsUnavailable = YES; }
    if (errorMessage != NULL) { *errorMessage = @"XCTest private display-targeted synthesis is only available on iOS"; }
    return NO;
#endif
}
