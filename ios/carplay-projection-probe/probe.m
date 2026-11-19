#import <Foundation/Foundation.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <limits.h>
#import <unistd.h>

// Self-deadline below the host's 15 s xcrun timeout: killing xcrun does not
// necessarily kill this process inside the simulator, so SIGALRM ends it.
static const unsigned int kProbeDeadlineSeconds = 10;

static NSString *displayIdentity(long long tag, int displayId) {
    NSString *kind;
    if (tag & 0x20) {
        kind = @"Car";
    } else if (tag & 0x40) {
        kind = @"CarInstruments";
    } else if (tag & 0x4) {
        kind = @"AirPlay";
    } else if (tag == 0) {
        kind = @"Untagged";
    } else {
        kind = [NSString stringWithFormat:@"Tag0x%llx", (unsigned long long)tag];
    }
    return [NSString stringWithFormat:@"%@[%d]", kind, displayId];
}

// Lower is preferred. On iOS 26.x the car display is TVOut (deviceName PurpleTVOut) and the
// Wireless screen's deviceName is a UUID; on iOS 27.0 the AirPlay display was wireless0. Pick by
// tag first so either layout reports its car display, and by name only for an untagged screen.
static int displayRank(long long tag, NSString *name, NSString *deviceName) {
    if (tag & 0x20) return 0;
    if (tag & 0x40) return 1;
    if (tag & 0x4) return 2;
    if ([name isEqualToString:@"TVOut"]) return 3;
    if ([deviceName isEqualToString:@"wireless0"]) return 4;
    return -1;
}

static id stringValue(id display, const char *selectorName) {
    SEL selector = sel_registerName(selectorName);
    if (![display respondsToSelector:selector]) return nil;
    id value = ((id (*)(id, SEL))objc_msgSend)(display, selector);
    return [value isKindOfClass:NSString.class] ? value : nil;
}

int main(void) {
    alarm(kProbeDeadlineSeconds);
    @autoreleasepool {
        Class displayClass = NSClassFromString(@"CADisplay");
        SEL displaysSelector = sel_registerName("displays");
        if (![displayClass respondsToSelector:displaysSelector]) {
            fprintf(stderr, "CADisplay displays is unavailable; check the simulator runtime.\n");
            return 1;
        }
        NSDictionary *state = @{
            @"found": @NO, @"tag": NSNull.null, @"displayId": NSNull.null,
            @"displayType": NSNull.null, @"identity": NSNull.null,
            @"name": NSNull.null, @"deviceName": NSNull.null,
            @"isCarDisplay": @NO, @"isCarInstrumentsDisplay": @NO
        };
        int bestRank = INT_MAX;
        SEL tagSelector = sel_registerName("tag");
        SEL typeSelector = sel_registerName("displayType");
        SEL idSelector = sel_registerName("displayId");
        NSArray *displays = ((id (*)(id, SEL))objc_msgSend)(displayClass, displaysSelector);
        for (id display in displays) {
            if (![display respondsToSelector:tagSelector] ||
                ![display respondsToSelector:typeSelector] ||
                ![display respondsToSelector:idSelector]) {
                fprintf(stderr, "CADisplay tag, displayType or displayId is unavailable.\n");
                return 1;
            }
            NSString *name = stringValue(display, "name") ?: @"";
            NSString *deviceName = stringValue(display, "deviceName") ?: @"";
            // These scalar casts match the tag-only simulator probe. Never construct
            // FBSDisplayConfiguration: an attached, powered-off display can crash it.
            long long tag = ((long long (*)(id, SEL))objc_msgSend)(display, tagSelector);
            int rank = displayRank(tag, name, deviceName);
            if (rank < 0 || rank >= bestRank) {
                continue;
            }
            bestRank = rank;
            long long displayType = ((long long (*)(id, SEL))objc_msgSend)(display, typeSelector);
            int displayId = ((int (*)(id, SEL))objc_msgSend)(display, idSelector);
            state = @{
                @"found": @YES, @"tag": @(tag), @"displayId": @(displayId),
                @"displayType": @(displayType), @"identity": displayIdentity(tag, displayId),
                @"name": name, @"deviceName": deviceName,
                @"isCarDisplay": ((tag & 0x20) != 0) ? @YES : @NO,
                @"isCarInstrumentsDisplay": ((tag & 0x40) != 0) ? @YES : @NO
            };
        }
        NSError *error = nil;
        NSData *json = [NSJSONSerialization dataWithJSONObject:state
                                                     options:NSJSONWritingSortedKeys
                                                       error:&error];
        if (!json) {
            fprintf(stderr, "Cannot encode projection state: %s\n", error.localizedDescription.UTF8String);
            return 1;
        }
        fwrite(json.bytes, 1, json.length, stdout);
        fputc('\n', stdout);
        return 0;
    }
}
