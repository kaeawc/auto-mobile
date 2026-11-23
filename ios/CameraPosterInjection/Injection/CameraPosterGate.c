// Launchd-environment gate for the camera poster (#19047). With this library in the simulator's
// DYLD_INSERT_LIBRARIES every process launchd_sim starts loads it, so it links nothing but
// libSystem and does nothing unless the process is a user-installed app (or one of its
// extensions) that already loaded AVFoundation and a poster source is configured. Only then does
// it load the poster library that AM_CAMERA_POSTER_DYLIB names. System apps and daemons
// (SpringBoard, Camera, anything under the runtime root) never load the poster.
#include <dlfcn.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// Installed apps live in the device's data/Containers/Bundle/Application/<UUID>/<Name>.app; system
// apps live under the runtime root (/Applications, /System, /usr), which never contains that path.
static int AMIsUserAppProcess(void) {
    char path[PATH_MAX];
    uint32_t size = sizeof(path);
    if (_NSGetExecutablePath(path, &size) != 0) return 0;
    return strstr(path, "/data/Containers/Bundle/Application/") != NULL && strstr(path, ".app/") != NULL;
}

static int AMHasAVFoundation(void) {
    uint32_t count = _dyld_image_count();
    for (uint32_t i = 0; i < count; i++) {
        const char *name = _dyld_get_image_name(i);
        if (name && strstr(name, "/AVFoundation.framework/")) return 1;
    }
    return 0;
}

static int AMHasPosterSource(void) {
    const char *path = getenv("AM_CAMERA_POSTER_PATH"), *qr = getenv("AM_CAMERA_POSTER_QR");
    if ((path && *path) || (qr && *qr)) return 1;
    const char *config = getenv("AM_CAMERA_POSTER_CONFIG");
    return config && *config && access(config, R_OK) == 0;
}

__attribute__((constructor)) static void AMGate(void) {
    if (!AMIsUserAppProcess() || !AMHasAVFoundation() || !AMHasPosterSource()) return;
    const char *library = getenv("AM_CAMERA_POSTER_DYLIB");
    if (!library || !*library) return;
    if (!dlopen(library, RTLD_NOW | RTLD_GLOBAL)) {
        fprintf(stderr, "[AMCameraPoster] gate could not load %s: %s\n", library, dlerror());
    }
}
