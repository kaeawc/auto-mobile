#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>

static int usage(const char *program) {
    fprintf(stderr, "Usage: %s <megabytes> (1..16384)\n", program);
    return 2;
}

static void stop(int signal_number) {
    (void)signal_number;
    /* Async-signal-safe; the kernel releases all mappings on exit. */
    _exit(0);
}

int main(int argc, char **argv) {
    if (argc != 2 || argv[1][0] == '\0') {
        return usage(argv[0]);
    }
    for (const char *digit = argv[1]; *digit != '\0'; ++digit) {
        if (*digit < '0' || *digit > '9') {
            return usage(argv[0]);
        }
    }
    errno = 0;
    unsigned long megabytes = strtoul(argv[1], NULL, 10);
    if (errno != 0 || megabytes < 1 || megabytes > 16384) {
        return usage(argv[0]);
    }

    struct sigaction action = {0};
    action.sa_handler = stop;
    if (sigemptyset(&action.sa_mask) == -1 ||
        sigaction(SIGTERM, &action, NULL) == -1 ||
        sigaction(SIGINT, &action, NULL) == -1) {
        perror("sigaction");
        return 1;
    }

    long page_size = sysconf(_SC_PAGESIZE);
    if (page_size <= 0 || (size_t)page_size % sizeof(uint32_t) != 0) {
        fprintf(stderr, "Unable to determine a supported page size\n");
        return 1;
    }

    const size_t mib = 1024 * 1024;
    size_t remaining = (size_t)megabytes * mib;
    uint32_t state = UINT32_C(0x9e3779b9);
    while (remaining > 0) {
        size_t chunk_size = remaining < 4 * mib ? remaining : 4 * mib;
        void *mapping = mmap(NULL, chunk_size, PROT_READ | PROT_WRITE,
                             MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (mapping == MAP_FAILED) {
            perror("mmap");
            return 1;
        }

        /* Fill entire pages with a continuous PRNG stream, rather than a
         * compressible repeated byte or a single dirty byte per page.
         * Volatile stores ensure the compiler retains every write. */
        volatile uint32_t *words = mapping;
        for (size_t page = 0; page < chunk_size; page += (size_t)page_size) {
            size_t end = page + (size_t)page_size;
            if (end > chunk_size) {
                end = chunk_size;
            }
            for (size_t offset = page; offset < end; offset += sizeof(uint32_t)) {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                words[offset / sizeof(uint32_t)] = state | UINT32_C(1);
            }
        }
        remaining -= chunk_size;
    }

    if (printf("READY %lu\n", megabytes) < 0 || fflush(stdout) == EOF) {
        perror("READY");
        return 1;
    }
    for (;;) {
        pause();
    }
}
