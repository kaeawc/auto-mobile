// Boot-environment gate for the camera poster (#19047). A simulator booted with this library in
// DYLD_INSERT_LIBRARIES loads it into every process launchd_sim starts, so it links nothing but
// libSystem and does nothing unless the process is an app (or app extension) that already loaded
// AVFoundation and a poster source is configured. Only then does it load the poster library
// that AM_CAMERA_POSTER_DYLIB names.
#include <dlfcn.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int AMIsAppProcess(void) {
    char path[PATH_MAX];
    uint32_t size = sizeof(path);
    return _NSGetExecutablePath(path, &size) == 0 && strstr(path, ".app/") != NULL;
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
    if (!AMIsAppProcess() || !AMHasAVFoundation() || !AMHasPosterSource()) return;
    const char *library = getenv("AM_CAMERA_POSTER_DYLIB");
    if (!library || !*library) return;
    if (!dlopen(library, RTLD_NOW | RTLD_GLOBAL)) {
        fprintf(stderr, "[AMCameraPoster] gate could not load %s: %s\n", library, dlerror());
    }
}
