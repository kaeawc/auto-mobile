// Vendored from kaeawc/auto-mobile-simulator crates/sim-netshape/native/netshape.c (MIT, commit 6323130).
// AutoMobile compiles it on demand (IosNetworkShaperDylibProvider) and boot-injects it (#19045).
// sim-rs network shaper: a dylib injected into iOS-simulator processes (DYLD_INSERT_LIBRARIES).
// It interposes BSD socket calls and applies a profile read from the file named by
// SIM_RS_NETSHAPE: offline, added latency, up/down bandwidth and connection loss. Only sockets
// connected to non-loopback addresses are shaped, so local control channels are unaffected.
// The profile is re-read when the file changes, so a controller can change it live.
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>

#define DYLD_INTERPOSE(_replacement, _replacee)                                                  \
    __attribute__((used)) static struct {                                                        \
        const void *replacement;                                                                 \
        const void *replacee;                                                                    \
    } _interpose_##_replacee __attribute__((section("__DATA,__interpose"))) = {                  \
        (const void *)(unsigned long)&_replacement, (const void *)(unsigned long)&_replacee};

// Batch socket calls used by Network.framework (private, exported by libsystem_kernel).
struct msghdr_x {
    void *msg_name;
    socklen_t msg_namelen;
    struct iovec *msg_iov;
    int msg_iovlen;
    void *msg_control;
    socklen_t msg_controllen;
    int msg_flags;
    size_t msg_datalen;
};
extern ssize_t sendmsg_x(int, const struct msghdr_x *, unsigned int, int);
extern ssize_t recvmsg_x(int, const struct msghdr_x *, unsigned int, int);

typedef struct {
    int offline;
    int latency_ms;
    long down_bps; // bytes per second, 0 = unlimited
    long up_bps;
    int loss_pct;  // TCP: percent of new connections that time out; UDP: percent of datagrams dropped
    int port_base; // >0: bind shaped sockets to source ports [port_base, port_base+port_count)
    int port_count;
} profile_t;

// A per-host override: `rule <pattern> key=value ...`. The pattern is a CIDR (`10.0.0.0/8`,
// `2001:db8::/32`), an address, a hostname suffix (`example.com` matches `api.example.com`), or `*`.
// Fields not given in the rule keep the base profile's values.
#define MAX_RULES 32
typedef struct {
    char pattern[128];
    int set_offline, offline, set_latency, latency_ms, set_down, set_up, set_loss, loss_pct;
    long down_bps, up_bps;
} rule_t;

static profile_t g_profile;
static rule_t g_rules[MAX_RULES];
static int g_nrules;
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static struct timespec g_mtime;
static double g_next_check;
static double g_down_free_at, g_up_free_at; // token-bucket "link busy until" times
#define MAX_FD 8192
static _Atomic unsigned char g_shaped[MAX_FD]; // 1 = shaped socket, 2 = shaped and last op was send
static _Atomic signed char g_rule[MAX_FD];     // matching rule index + 1 for the socket's peer, 0 = none
static _Atomic unsigned char g_seen[MAX_FD];   // 1 once the first outgoing bytes were inspected
static _Atomic unsigned char g_tstamp[MAX_FD]; // UDP: SO_TIMESTAMP enabled by us
static _Atomic unsigned char g_debt[MAX_FD];   // TCP: handshake round trip owed by the first receive
// libSystem's own socket calls can call each other (recv -> recvfrom); count only the outermost.
static __thread int g_depth;

// Hostnames learned from this process's DNS lookups, so hostname rules can match addresses.
#define MAX_NAMES 256
typedef struct {
    struct sockaddr_storage addr;
    char name[128];
} learned_t;
static learned_t g_names[MAX_NAMES];
static int g_nnames;
static pthread_mutex_t g_names_lock = PTHREAD_MUTEX_INITIALIZER;

static double now_s(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void sleep_s(double s) {
    if (s <= 0) return;
    struct timespec ts = {(time_t)s, (long)((s - (time_t)s) * 1e9)};
    while (nanosleep(&ts, &ts) == -1 && errno == EINTR) {}
}

static void reload(void) {
    double t = now_s();
    pthread_mutex_lock(&g_lock);
    if (t < g_next_check) {
        pthread_mutex_unlock(&g_lock);
        return;
    }
    g_next_check = t + 0.25;
    const char *path = getenv("SIM_RS_NETSHAPE");
    struct stat st;
    if (!path || stat(path, &st) != 0) {
        memset(&g_profile, 0, sizeof g_profile);
        pthread_mutex_unlock(&g_lock);
        return;
    }
    if (st.st_mtimespec.tv_sec == g_mtime.tv_sec && st.st_mtimespec.tv_nsec == g_mtime.tv_nsec) {
        pthread_mutex_unlock(&g_lock);
        return;
    }
    g_mtime = st.st_mtimespec;
    profile_t p = {0};
    rule_t rules[MAX_RULES];
    int nrules = 0;
    FILE *f = fopen(path, "r");
    if (f) {
        char line[512];
        while (fgets(line, sizeof line, f)) {
            char key[64];
            long value;
            if (!strncmp(line, "rule ", 5)) {
                if (nrules >= MAX_RULES) continue;
                rule_t *r = &rules[nrules];
                memset(r, 0, sizeof *r);
                char *save = NULL, *tok = strtok_r(line + 5, " \t\r\n", &save);
                if (!tok) continue;
                snprintf(r->pattern, sizeof r->pattern, "%s", tok);
                while ((tok = strtok_r(NULL, " \t\r\n", &save))) {
                    if (sscanf(tok, "%63[^=]=%ld", key, &value) != 2) continue;
                    if (!strcmp(key, "offline")) { r->set_offline = 1; r->offline = (int)value; }
                    else if (!strcmp(key, "latency_ms")) { r->set_latency = 1; r->latency_ms = (int)value; }
                    else if (!strcmp(key, "down_kbps")) { r->set_down = 1; r->down_bps = value * 1000 / 8; }
                    else if (!strcmp(key, "up_kbps")) { r->set_up = 1; r->up_bps = value * 1000 / 8; }
                    else if (!strcmp(key, "loss_pct")) { r->set_loss = 1; r->loss_pct = (int)value; }
                }
                nrules++;
                continue;
            }
            if (sscanf(line, " %63[^= ] = %ld", key, &value) != 2) continue;
            if (!strcmp(key, "offline")) p.offline = (int)value;
            else if (!strcmp(key, "latency_ms")) p.latency_ms = (int)value;
            else if (!strcmp(key, "down_kbps")) p.down_bps = value * 1000 / 8;
            else if (!strcmp(key, "up_kbps")) p.up_bps = value * 1000 / 8;
            else if (!strcmp(key, "loss_pct")) p.loss_pct = (int)value;
            else if (!strcmp(key, "port_base")) p.port_base = (int)value;
            else if (!strcmp(key, "port_count")) p.port_count = (int)value;
        }
        fclose(f);
    }
    g_profile = p;
    memcpy(g_rules, rules, sizeof(rule_t) * (size_t)nrules);
    g_nrules = nrules;
    pthread_mutex_unlock(&g_lock);
}

static int same_addr(const struct sockaddr *a, const struct sockaddr_storage *b) {
    if (a->sa_family != b->ss_family) return 0;
    if (a->sa_family == AF_INET)
        return ((const struct sockaddr_in *)a)->sin_addr.s_addr == ((const struct sockaddr_in *)b)->sin_addr.s_addr;
    if (a->sa_family == AF_INET6)
        return !memcmp(&((const struct sockaddr_in6 *)a)->sin6_addr, &((const struct sockaddr_in6 *)b)->sin6_addr, 16);
    return 0;
}

/// Records that `name` resolved to `sa` (most recent wins; a small ring).
static void learn(const char *name, const struct sockaddr *sa) {
    if (!name || !sa || (sa->sa_family != AF_INET && sa->sa_family != AF_INET6)) return;
    pthread_mutex_lock(&g_names_lock);
    learned_t *slot = &g_names[g_nnames % MAX_NAMES];
    for (int i = 0; i < MAX_NAMES && i < g_nnames; i++)
        if (same_addr(sa, &g_names[i].addr)) { slot = &g_names[i]; goto fill; }
    g_nnames++;
fill:
    memset(&slot->addr, 0, sizeof slot->addr);
    memcpy(&slot->addr, sa, sa->sa_len <= sizeof slot->addr ? sa->sa_len : sizeof slot->addr);
    snprintf(slot->name, sizeof slot->name, "%s", name);
    size_t len = strlen(slot->name);
    if (len > 1 && slot->name[len - 1] == '.') slot->name[len - 1] = 0; // resolvers return FQDNs
    pthread_mutex_unlock(&g_names_lock);
}

static int name_of(const struct sockaddr *sa, char *out, size_t len) {
    int found = 0;
    pthread_mutex_lock(&g_names_lock);
    for (int i = 0; i < MAX_NAMES && i < g_nnames; i++)
        if (same_addr(sa, &g_names[i].addr)) { snprintf(out, len, "%s", g_names[i].name); found = 1; break; }
    pthread_mutex_unlock(&g_names_lock);
    return found;
}

static int suffix_match(const char *name, const char *pattern) {
    size_t n = strlen(name), p = strlen(pattern);
    if (p > n) return 0;
    if (strcasecmp(name + n - p, pattern)) return 0;
    return n == p || name[n - p - 1] == '.';
}

static int cidr_match(const struct sockaddr *sa, const char *pattern) {
    char buf[128];
    snprintf(buf, sizeof buf, "%s", pattern);
    int bits = -1;
    char *slash = strchr(buf, '/');
    if (slash) { *slash = 0; bits = atoi(slash + 1); }
    unsigned char want[16], have[16];
    int len;
    if (sa->sa_family == AF_INET && inet_pton(AF_INET, buf, want) == 1) {
        memcpy(have, &((const struct sockaddr_in *)sa)->sin_addr, 4);
        len = 4;
    } else if (sa->sa_family == AF_INET6 && inet_pton(AF_INET6, buf, want) == 1) {
        memcpy(have, &((const struct sockaddr_in6 *)sa)->sin6_addr, 16);
        len = 16;
    } else {
        return 0;
    }
    if (bits < 0 || bits > len * 8) bits = len * 8;
    for (int i = 0; i < bits; i++)
        if (((want[i / 8] >> (7 - i % 8)) & 1) != ((have[i / 8] >> (7 - i % 8)) & 1)) return 0;
    return 1;
}

/// Index + 1 of the first rule matching the peer `sa`, or 0.
static int match_rule(const struct sockaddr *sa) {
    if (!sa) return 0;
    reload(); // the first connection in a process may come before anything else loaded the rules
    char name[128];
    int named = name_of(sa, name, sizeof name);
    pthread_mutex_lock(&g_lock);
    int hit = 0;
    for (int i = 0; i < g_nrules && !hit; i++) {
        const char *pat = g_rules[i].pattern;
        if (!strcmp(pat, "*") || cidr_match(sa, pat) || (named && suffix_match(name, pat))) hit = i + 1;
    }
    pthread_mutex_unlock(&g_lock);
    return hit;
}

/// Index + 1 of the first rule matching a hostname (for DNS lookups), or 0.
static int match_rule_name(const char *name) {
    if (!name) return 0;
    reload();
    char clean[128];
    snprintf(clean, sizeof clean, "%s", name);
    size_t len = strlen(clean);
    if (len > 1 && clean[len - 1] == '.') clean[len - 1] = 0;
    pthread_mutex_lock(&g_lock);
    int hit = 0;
    for (int i = 0; i < g_nrules && !hit; i++)
        if (!strcmp(g_rules[i].pattern, "*") || suffix_match(clean, g_rules[i].pattern)) hit = i + 1;
    pthread_mutex_unlock(&g_lock);
    return hit;
}

/// The profile in effect for a socket: the base profile with its peer's rule applied.
static profile_t effective(int rule) {
    reload();
    pthread_mutex_lock(&g_lock);
    profile_t p = g_profile;
    if (rule > 0 && rule <= g_nrules) {
        const rule_t *r = &g_rules[rule - 1];
        if (r->set_offline) p.offline = r->offline;
        if (r->set_latency) p.latency_ms = r->latency_ms;
        if (r->set_down) p.down_bps = r->down_bps;
        if (r->set_up) p.up_bps = r->up_bps;
        if (r->set_loss) p.loss_pct = r->loss_pct;
    }
    pthread_mutex_unlock(&g_lock);
    return p;
}

static profile_t for_fd(int fd) { return effective(fd >= 0 && fd < MAX_FD ? atomic_load(&g_rule[fd]) : 0); }

static int is_dgram(int fd) {
    int type = 0;
    socklen_t len = sizeof type;
    return getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &len) == 0 && type == SOCK_DGRAM;
}

static int is_remote(const struct sockaddr *sa) {
    if (!sa) return 0;
    if (sa->sa_family == AF_INET) {
        const struct sockaddr_in *in = (const struct sockaddr_in *)sa;
        return (ntohl(in->sin_addr.s_addr) >> 24) != 127;
    }
    if (sa->sa_family == AF_INET6) {
        const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)sa;
        if (IN6_IS_ADDR_LOOPBACK(&in6->sin6_addr)) return 0;
        if (IN6_IS_ADDR_V4MAPPED(&in6->sin6_addr)) return in6->sin6_addr.s6_addr[12] != 127;
        return 1;
    }
    return 0;
}

static int shaped(int fd) { return fd >= 0 && fd < MAX_FD && atomic_load(&g_shaped[fd]); }

/// Binds an unbound socket to a free source port in the profile's range, so host packet filters
/// (pf + dummynet) can shape exactly this app's traffic. Best effort: failures leave it unbound.
static void bind_port(int fd, const struct sockaddr *dst, const profile_t *p) {
    if (p->port_base <= 0) return;
    int count = p->port_count > 0 ? p->port_count : 1000;
    static _Atomic unsigned next;
    for (int i = 0; i < count; i++) {
        unsigned port = (unsigned)p->port_base + (atomic_fetch_add(&next, 1) % (unsigned)count);
        struct sockaddr_storage ss;
        memset(&ss, 0, sizeof ss);
        socklen_t len;
        if (dst->sa_family == AF_INET6) {
            struct sockaddr_in6 *a = (struct sockaddr_in6 *)&ss;
            a->sin6_family = AF_INET6;
            a->sin6_len = sizeof *a;
            a->sin6_port = htons((uint16_t)port);
            len = sizeof *a;
        } else {
            struct sockaddr_in *a = (struct sockaddr_in *)&ss;
            a->sin_family = AF_INET;
            a->sin_len = sizeof *a;
            a->sin_port = htons((uint16_t)port);
            len = sizeof *a;
        }
        if (bind(fd, (struct sockaddr *)&ss, len) == 0) return;
        if (errno != EADDRINUSE) return; // already bound, or not bindable: leave it
    }
}

/// Gate for a new connection to `sa`: returns 0 to proceed, or -1 with errno set.
static int admit(int fd, const struct sockaddr *sa) {
    if (fd >= 0 && fd < MAX_FD) { atomic_store(&g_shaped[fd], 0); atomic_store(&g_rule[fd], 0); atomic_store(&g_seen[fd], 0); atomic_store(&g_debt[fd], 0); }
    if (!is_remote(sa)) return 0;
    int rule = match_rule(sa);
    if (fd >= 0 && fd < MAX_FD) { atomic_store(&g_shaped[fd], 1); atomic_store(&g_rule[fd], (signed char)rule); }
    profile_t p = effective(rule);
    if (p.offline) {
        errno = ENETUNREACH;
        return -1;
    }
    if (is_dgram(fd)) return 0; // UDP "connect" only sets the peer; datagrams are shaped one by one
    // TCP does not lose connections, it retransmits: each lost SYN costs the initial retransmission
    // timeout (1 s, doubling). Six losses in a row time the connection out, as the kernel would.
    double rto = 1.0;
    for (int tries = 0; p.loss_pct > 0 && arc4random_uniform(100) < (unsigned)p.loss_pct; tries++) {
        if (tries == 6) {
            errno = ETIMEDOUT;
            return -1;
        }
        sleep_s(rto);
        rto *= 2;
    }
    bind_port(fd, sa, &p);
    // The handshake round trip, paid where a real connect would wait. (Deferring it for
    // non-blocking sockets made Network.framework report "ready" a round trip early.)
    sleep_s(p.latency_ms / 1000.0);
    return 0;
}

/// Extracts the TLS SNI hostname from a ClientHello record. Returns 1 on success.
static int tls_sni(const unsigned char *b, size_t n, char *out, size_t outlen) {
    if (n < 43 || b[0] != 0x16 || b[1] != 0x03 || b[5] != 0x01) return 0; // handshake record, ClientHello
    size_t i = 5 + 4 + 2 + 32;                                             // header, hs header, version, random
    if (i >= n) return 0;
    i += 1 + b[i];                                                          // session id
    if (i + 2 > n) return 0;
    i += 2 + ((size_t)b[i] << 8 | b[i + 1]);                                // cipher suites
    if (i + 1 > n) return 0;
    i += 1 + b[i];                                                          // compression methods
    if (i + 2 > n) return 0;
    size_t end = i + 2 + ((size_t)b[i] << 8 | b[i + 1]);
    i += 2;
    while (i + 4 <= n && i + 4 <= end) {
        unsigned type = (unsigned)b[i] << 8 | b[i + 1];
        size_t len = (size_t)b[i + 2] << 8 | b[i + 3];
        i += 4;
        if (type == 0 && i + 5 <= n) {                                      // server_name
            size_t name_len = (size_t)b[i + 3] << 8 | b[i + 4];
            if (b[i + 2] != 0 || i + 5 + name_len > n || name_len >= outlen) return 0;
            memcpy(out, b + i + 5, name_len);
            out[name_len] = 0;
            return 1;
        }
        i += len;
    }
    return 0;
}

/// Extracts the Host header from a plain HTTP request. Returns 1 on success.
static int http_host(const unsigned char *b, size_t n, char *out, size_t outlen) {
    static const char *methods[] = {"GET ", "POST ", "PUT ", "HEAD ", "DELETE ", "PATCH ", "OPTIONS "};
    int is_http = 0;
    for (size_t m = 0; m < sizeof methods / sizeof *methods; m++)
        if (n > strlen(methods[m]) && !memcmp(b, methods[m], strlen(methods[m]))) is_http = 1;
    if (!is_http) return 0;
    for (size_t i = 0; i + 6 < n; i++) {
        if ((b[i] == '\n') && (b[i + 1] == 'H' || b[i + 1] == 'h') && !strncasecmp((const char *)b + i + 1, "host:", 5)) {
            size_t j = i + 6, k = 0;
            while (j < n && b[j] == ' ') j++;
            while (j < n && b[j] != '\r' && b[j] != '\n' && b[j] != ':' && k + 1 < outlen) out[k++] = (char)b[j++];
            out[k] = 0;
            return k > 0;
        }
    }
    return 0;
}

/// Inspects the first outgoing bytes of a shaped TCP socket for its hostname (TLS SNI or HTTP Host),
/// learns it and re-matches rules. Returns -1 with errno set if a hostname rule makes it offline.
static int inspect_first(int fd, const void *buf, size_t n) {
    if (!shaped(fd) || !buf || n == 0 || atomic_exchange(&g_seen[fd], 1)) return 0;
    char name[128];
    if (!tls_sni(buf, n, name, sizeof name) && !http_host(buf, n, name, sizeof name)) return 0;
    struct sockaddr_storage peer;
    socklen_t len = sizeof peer;
    if (getpeername(fd, (struct sockaddr *)&peer, &len) != 0) return 0;
    learn(name, (struct sockaddr *)&peer);
    int rule = match_rule((struct sockaddr *)&peer);
    int before = atomic_exchange(&g_rule[fd], (signed char)rule);
    profile_t p = effective(rule);
    if (p.offline) {
        errno = ECONNRESET;
        return -1;
    }
    // The handshake ran under the previous match; charge its round trip if the name changed it.
    if (rule != before) atomic_store(&g_debt[fd], 1);
    return 0;
}

/// Gate for one outgoing datagram on a shaped socket (or to remote `to`). Returns 1 to drop it
/// silently (loss), -1 with errno for offline, 0 to send.
static int datagram_out(int fd, const struct sockaddr *to) {
    if (to && is_remote(to) && fd >= 0 && fd < MAX_FD) {
        atomic_store(&g_shaped[fd], 1);
        atomic_store(&g_rule[fd], (signed char)match_rule(to));
    }
    if (!shaped(fd) || !is_dgram(fd)) return 0;
    profile_t p = for_fd(fd);
    if (p.offline) {
        errno = ENETUNREACH;
        return -1;
    }
    if (p.loss_pct > 0 && arc4random_uniform(100) < (unsigned)p.loss_pct) return 1;
    return 0; // latency is charged on the receive side (see deliver_at)
}

static double wall_s(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return tv.tv_sec + tv.tv_usec / 1e6;
}

/// UDP delay line: a datagram becomes visible at its kernel arrival time plus the latency. Datagrams
/// that arrived together are released together, and request/response pays exactly one round trip.
/// Returns 1 if the socket is a shaped datagram socket with latency (so callers want timestamps).
static int udp_delayed(int fd, profile_t *out) {
    if (!shaped(fd) || !is_dgram(fd)) return 0;
    profile_t p = for_fd(fd);
    if (p.latency_ms <= 0) return 0;
    if (!atomic_exchange(&g_tstamp[fd], 1)) {
        int on = 1;
        setsockopt(fd, SOL_SOCKET, SO_TIMESTAMP, &on, sizeof on);
    }
    *out = p;
    return 1;
}

static void deliver_at(double arrival, const profile_t *p) {
    if (arrival <= 0) arrival = wall_s();
    sleep_s(arrival + p->latency_ms / 1000.0 - wall_s());
}

/// Kernel arrival time from an SCM_TIMESTAMP control message, or 0.
static double cmsg_arrival(const struct msghdr *m) {
    if (!m || !m->msg_control || m->msg_controllen < sizeof(struct cmsghdr)) return 0;
    for (struct cmsghdr *c = CMSG_FIRSTHDR(m); c; c = CMSG_NXTHDR((struct msghdr *)m, c)) {
        if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_TIMESTAMP) {
            struct timeval tv;
            memcpy(&tv, CMSG_DATA(c), sizeof tv);
            return tv.tv_sec + tv.tv_usec / 1e6;
        }
    }
    return 0;
}

/// recv/recvfrom on a delayed UDP socket, through recvmsg so the arrival timestamp is visible.
static ssize_t udp_recv(int fd, void *b, size_t n, int fl, struct sockaddr *from, socklen_t *fromlen, const profile_t *p) {
    struct iovec iov = {b, n};
    char control[256];
    struct msghdr m = {0};
    m.msg_name = from;
    m.msg_namelen = fromlen ? *fromlen : 0;
    m.msg_iov = &iov;
    m.msg_iovlen = 1;
    m.msg_control = control;
    m.msg_controllen = sizeof control;
    g_depth++;
    ssize_t r = recvmsg(fd, &m, fl);
    g_depth--;
    if (r >= 0) {
        if (fromlen) *fromlen = m.msg_namelen;
        if (!(fl & MSG_PEEK)) deliver_at(cmsg_arrival(&m), p);
    }
    return r;
}

/// Accounts `bytes` on a shaped socket and sleeps as the profile requires.
static void pace(int fd, ssize_t bytes, int sending) {
    if (!shaped(fd) || bytes <= 0) return;
    profile_t p = for_fd(fd);
    int dgram = is_dgram(fd);
    // Request -> response turnaround: data received after this socket sent costs a round trip.
    // Exact for request/response protocols; TCP hides segment arrival times, so pipelined traffic
    // (HTTP/2 control frames sent mid-response) can be charged extra round trips. Use pf/dummynet
    // (scripts/pf-shape.sh) when that matters.
    if (!sending && !dgram && p.latency_ms > 0) {
        int owed = atomic_exchange(&g_debt[fd], 0) + (atomic_load(&g_shaped[fd]) == 2);
        sleep_s(owed * p.latency_ms / 1000.0);
    }

    // A lost TCP segment stalls the stream for a retransmission (about 200 ms plus a round trip).
    if (!dgram && p.loss_pct > 0 && arc4random_uniform(100) < (unsigned)p.loss_pct) sleep_s(0.2 + p.latency_ms / 1000.0);
    if (!dgram) atomic_store(&g_shaped[fd], sending ? 2 : 1);
    long rate = sending ? p.up_bps : p.down_bps;
    if (rate <= 0) return;
    pthread_mutex_lock(&g_lock);
    double *free_at = sending ? &g_up_free_at : &g_down_free_at;
    double t = now_s();
    double start = *free_at > t ? *free_at : t;
    *free_at = start + (double)bytes / (double)rate;
    double wait = *free_at - t;
    pthread_mutex_unlock(&g_lock);
    sleep_s(wait);
}

static int sock_fd(int fd) {
    struct stat st;
    return fd >= 0 && fstat(fd, &st) == 0 && S_ISSOCK(st.st_mode);
}

static int my_connect(int fd, const struct sockaddr *sa, socklen_t len) {
    if (admit(fd, sa) != 0) return -1;
    return connect(fd, sa, len);
}
DYLD_INTERPOSE(my_connect, connect)

static int my_connectx(int fd, const sa_endpoints_t *ep, sae_associd_t aid, unsigned int flags, const struct iovec *iov,
                       unsigned int iovcnt, size_t *len, sae_connid_t *cid) {
    if (ep && admit(fd, ep->sae_dstaddr) != 0) return -1;
    return connectx(fd, ep, aid, flags, iov, iovcnt, len, cid);
}
DYLD_INTERPOSE(my_connectx, connectx)

#define OUTER(call) (g_depth++, _r = (call), g_depth--, g_depth == 0)

static ssize_t my_send(int fd, const void *b, size_t n, int fl) {
    ssize_t _r;
    if (g_depth == 0) {
        int gate = datagram_out(fd, NULL);
        if (gate < 0) return -1;
        if (gate > 0) return (ssize_t)n;
        if (!is_dgram(fd) && inspect_first(fd, b, n) < 0) return -1;
    }
    if (OUTER(send(fd, b, n, fl))) pace(fd, _r, 1);
    return _r;
}
DYLD_INTERPOSE(my_send, send)

static ssize_t my_sendto(int fd, const void *b, size_t n, int fl, const struct sockaddr *to, socklen_t tl) {
    ssize_t _r;
    if (g_depth == 0) {
        int gate = datagram_out(fd, to);
        if (gate < 0) return -1;
        if (gate > 0) return (ssize_t)n;
        if (!is_dgram(fd) && inspect_first(fd, b, n) < 0) return -1;
    }
    if (OUTER(sendto(fd, b, n, fl, to, tl))) pace(fd, _r, 1);
    return _r;
}
DYLD_INTERPOSE(my_sendto, sendto)

static ssize_t iov_total(const struct iovec *v, int c) {
    ssize_t t = 0;
    for (int i = 0; v && i < c; i++) t += (ssize_t)v[i].iov_len;
    return t;
}

static ssize_t my_sendmsg(int fd, const struct msghdr *m, int fl) {
    ssize_t _r;
    if (g_depth == 0) {
        int gate = datagram_out(fd, m ? (const struct sockaddr *)m->msg_name : NULL);
        if (gate < 0) return -1;
        if (gate > 0) return m ? iov_total(m->msg_iov, m->msg_iovlen) : 0;
        if (m && m->msg_iovlen > 0 && !is_dgram(fd) && inspect_first(fd, m->msg_iov[0].iov_base, m->msg_iov[0].iov_len) < 0) return -1;
    }
    if (OUTER(sendmsg(fd, m, fl))) pace(fd, _r, 1);
    return _r;
}
DYLD_INTERPOSE(my_sendmsg, sendmsg)

static ssize_t my_recv(int fd, void *b, size_t n, int fl) {
    ssize_t _r;
    profile_t up;
    if (g_depth == 0 && udp_delayed(fd, &up)) return udp_recv(fd, b, n, fl, NULL, NULL, &up);
    if (OUTER(recv(fd, b, n, fl))) pace(fd, _r, 0);
    return _r;
}
DYLD_INTERPOSE(my_recv, recv)

static ssize_t my_recvfrom(int fd, void *b, size_t n, int fl, struct sockaddr *from, socklen_t *fl2) {
    ssize_t _r;
    profile_t up;
    if (g_depth == 0 && udp_delayed(fd, &up)) return udp_recv(fd, b, n, fl, from, fl2, &up);
    if (OUTER(recvfrom(fd, b, n, fl, from, fl2))) pace(fd, _r, 0);
    return _r;
}
DYLD_INTERPOSE(my_recvfrom, recvfrom)

static ssize_t my_recvmsg(int fd, struct msghdr *m, int fl) {
    ssize_t _r;
    profile_t up;
    int delayed = g_depth == 0 && udp_delayed(fd, &up);
    if (OUTER(recvmsg(fd, m, fl))) {
        if (delayed && _r >= 0 && !(fl & MSG_PEEK)) deliver_at(cmsg_arrival(m), &up);
        pace(fd, _r, 0);
    }
    return _r;
}
DYLD_INTERPOSE(my_recvmsg, recvmsg)

static ssize_t datalen(const struct msghdr_x *m, ssize_t count) {
    ssize_t total = 0;
    for (ssize_t i = 0; i < count; i++) total += (ssize_t)m[i].msg_datalen;
    return total;
}

static ssize_t my_sendmsg_x(int fd, const struct msghdr_x *m, unsigned int cnt, int fl) {
    ssize_t _r;
    if (g_depth == 0 && cnt > 0) {
        int gate = datagram_out(fd, (const struct sockaddr *)m[0].msg_name);
        if (gate < 0) return -1;
        if (gate > 0) return (ssize_t)cnt; // the whole batch is lost
        if (m[0].msg_iovlen > 0 && !is_dgram(fd) && inspect_first(fd, m[0].msg_iov[0].iov_base, m[0].msg_iov[0].iov_len) < 0) return -1;
    }
    if (OUTER(sendmsg_x(fd, m, cnt, fl)) && _r > 0 && shaped(fd)) {
        ssize_t total = 0;
        for (ssize_t i = 0; i < _r; i++) total += iov_total(m[i].msg_iov, m[i].msg_iovlen);
        pace(fd, total, 1);
    }
    return _r;
}
DYLD_INTERPOSE(my_sendmsg_x, sendmsg_x)

static ssize_t my_recvmsg_x(int fd, const struct msghdr_x *m, unsigned int cnt, int fl) {
    ssize_t _r;
    profile_t up;
    int delayed = g_depth == 0 && udp_delayed(fd, &up);
    if (OUTER(recvmsg_x(fd, m, cnt, fl)) && _r > 0) {
        if (delayed) {
            // The batch becomes visible when its newest datagram is due.
            double newest = 0;
            for (ssize_t i = 0; i < _r; i++) {
                struct msghdr h = {0};
                h.msg_control = m[i].msg_control;
                h.msg_controllen = m[i].msg_controllen;
                double a = cmsg_arrival(&h);
                if (a > newest) newest = a;
            }
            deliver_at(newest, &up);
        }
        pace(fd, datalen(m, _r), 0);
    }
    return _r;
}
DYLD_INTERPOSE(my_recvmsg_x, recvmsg_x)

static ssize_t my_write(int fd, const void *b, size_t n) {
    ssize_t _r;
    if (g_depth == 0 && shaped(fd) && !is_dgram(fd) && inspect_first(fd, b, n) < 0) return -1;
    if (OUTER(write(fd, b, n)) && shaped(fd)) pace(fd, _r, 1);
    return _r;
}
DYLD_INTERPOSE(my_write, write)

static ssize_t my_read(int fd, void *b, size_t n) {
    ssize_t _r;
    if (OUTER(read(fd, b, n)) && shaped(fd)) pace(fd, _r, 0);
    return _r;
}
DYLD_INTERPOSE(my_read, read)

static ssize_t my_writev(int fd, const struct iovec *v, int c) {
    ssize_t _r;
    if (g_depth == 0 && shaped(fd) && c > 0 && !is_dgram(fd) && inspect_first(fd, v[0].iov_base, v[0].iov_len) < 0) return -1;
    if (OUTER(writev(fd, v, c)) && shaped(fd)) pace(fd, _r, 1);
    return _r;
}
DYLD_INTERPOSE(my_writev, writev)

static ssize_t my_readv(int fd, const struct iovec *v, int c) {
    ssize_t _r;
    if (OUTER(readv(fd, v, c)) && shaped(fd)) pace(fd, _r, 0);
    return _r;
}
DYLD_INTERPOSE(my_readv, readv)

static int my_close(int fd) {
    if (fd >= 0 && fd < MAX_FD) { atomic_store(&g_shaped[fd], 0); atomic_store(&g_rule[fd], 0); atomic_store(&g_seen[fd], 0); }
    return close(fd);
}
DYLD_INTERPOSE(my_close, close)

// ---- DNS: learn names (for hostname rules) and fail lookups while offline ----

static int is_literal(const char *node) {
    struct in_addr a4;
    struct in6_addr a6;
    return inet_pton(AF_INET, node, &a4) == 1 || inet_pton(AF_INET6, node, &a6) == 1;
}

/// A DNS lookup is one round trip on the shaped link, and fails while the host (or all) is offline.
static int my_getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **res) {
    if (node && !is_literal(node)) {
        profile_t p = effective(match_rule_name(node));
        if (p.offline) return EAI_NONAME;
        sleep_s(p.latency_ms / 1000.0);
    }
    int r = getaddrinfo(node, service, hints, res);
    if (r == 0 && node)
        for (struct addrinfo *ai = *res; ai; ai = ai->ai_next) learn(node, ai->ai_addr);
    return r;
}
DYLD_INTERPOSE(my_getaddrinfo, getaddrinfo)

// DNSServiceGetAddrInfo (dns_sd), used by CFNetwork/Network.framework resolvers in some paths.
typedef void *DNSServiceRef;
typedef void (*DNSServiceGetAddrInfoReply)(DNSServiceRef, uint32_t, uint32_t, int32_t, const char *, const struct sockaddr *, uint32_t, void *);
extern int32_t DNSServiceGetAddrInfo(DNSServiceRef *, uint32_t, uint32_t, uint32_t, const char *, DNSServiceGetAddrInfoReply, void *);
typedef struct {
    DNSServiceGetAddrInfoReply reply;
    void *context;
    double delay; // seconds to hold the first answer (one round trip)
} dns_ctx_t;
static void dns_reply(DNSServiceRef ref, uint32_t flags, uint32_t ifi, int32_t err, const char *host, const struct sockaddr *addr, uint32_t ttl, void *ctx) {
    dns_ctx_t *c = ctx;
    if (c->delay > 0) {
        sleep_s(c->delay);
        c->delay = 0;
    }
    if (err == 0) learn(host, addr);
    c->reply(ref, flags, ifi, err, host, addr, ttl, c->context);
}
#define kDNSServiceErr_NoSuchName (-65538)
/// Offline (for this name): the query fails up front, as with no network.
static int dns_blocked(const char *host, double *delay) {
    profile_t p = effective(match_rule_name(host));
    *delay = p.latency_ms / 1000.0;
    return p.offline;
}
static int32_t my_DNSServiceGetAddrInfo(DNSServiceRef *ref, uint32_t flags, uint32_t ifi, uint32_t proto, const char *host, DNSServiceGetAddrInfoReply reply, void *ctx) {
    double delay = 0;
    if (host && dns_blocked(host, &delay)) return kDNSServiceErr_NoSuchName;
    dns_ctx_t *c = malloc(sizeof *c); // lives as long as the query; small and rare
    if (!c || !reply) return DNSServiceGetAddrInfo(ref, flags, ifi, proto, host, reply, ctx);
    c->reply = reply;
    c->context = ctx;
    c->delay = delay;
    return DNSServiceGetAddrInfo(ref, flags, ifi, proto, host, dns_reply, c);
}
DYLD_INTERPOSE(my_DNSServiceGetAddrInfo, DNSServiceGetAddrInfo)

// The attribute-taking variant, which libnetwork (Network.framework, URLSession) uses.
extern int32_t DNSServiceGetAddrInfoEx(DNSServiceRef *, uint32_t, uint32_t, uint32_t, const char *, const void *, DNSServiceGetAddrInfoReply, void *);
static int32_t my_DNSServiceGetAddrInfoEx(DNSServiceRef *ref, uint32_t flags, uint32_t ifi, uint32_t proto, const char *host, const void *attr, DNSServiceGetAddrInfoReply reply, void *ctx) {
    double delay = 0;
    if (host && dns_blocked(host, &delay)) return kDNSServiceErr_NoSuchName;
    dns_ctx_t *c = malloc(sizeof *c);
    if (!c || !reply) return DNSServiceGetAddrInfoEx(ref, flags, ifi, proto, host, attr, reply, ctx);
    c->reply = reply;
    c->context = ctx;
    c->delay = delay;
    return DNSServiceGetAddrInfoEx(ref, flags, ifi, proto, host, attr, dns_reply, c);
}
DYLD_INTERPOSE(my_DNSServiceGetAddrInfoEx, DNSServiceGetAddrInfoEx)

// ---- Path status: while the whole profile is offline, the device has no network path ----
// NWPathMonitor, URLSession's connectivity checks and SCNetworkReachability then report
// "offline" (-1009) the way airplane mode does, instead of only failing connections.
typedef void *nw_path_t;
extern int nw_path_get_status(nw_path_t);
static int my_nw_path_get_status(nw_path_t path) {
    int status = nw_path_get_status(path);
    return effective(0).offline && status == 1 /* satisfied */ ? 2 /* unsatisfied */ : status;
}
DYLD_INTERPOSE(my_nw_path_get_status, nw_path_get_status)

typedef const void *SCNetworkReachabilityRef;
extern unsigned char SCNetworkReachabilityGetFlags(SCNetworkReachabilityRef, uint32_t *);
static unsigned char my_SCNetworkReachabilityGetFlags(SCNetworkReachabilityRef target, uint32_t *flags) {
    unsigned char ok = SCNetworkReachabilityGetFlags(target, flags);
    if (ok && flags && effective(0).offline) *flags = 0;
    return ok;
}
DYLD_INTERPOSE(my_SCNetworkReachabilityGetFlags, SCNetworkReachabilityGetFlags)

// dnssd_getaddrinfo (libdns_services), the resolver Network.framework and URLSession use. Every
// address handed to the client passes through this getter, so the name is learned before connect.
typedef void *dnssd_getaddrinfo_result_t;
extern const struct sockaddr *dnssd_getaddrinfo_result_get_address(dnssd_getaddrinfo_result_t);
extern const char *dnssd_getaddrinfo_result_get_hostname(dnssd_getaddrinfo_result_t);
static const struct sockaddr *my_dnssd_get_address(dnssd_getaddrinfo_result_t result) {
    const struct sockaddr *addr = dnssd_getaddrinfo_result_get_address(result);
    if (addr) learn(dnssd_getaddrinfo_result_get_hostname(result), addr);
    return addr;
}
DYLD_INTERPOSE(my_dnssd_get_address, dnssd_getaddrinfo_result_get_address)

__attribute__((constructor)) static void netshape_init(void) {
    const char *marker = getenv("SIM_RS_NETSHAPE_MARK");
    if (marker) {
        int fd = open(marker, O_WRONLY | O_CREAT | O_APPEND, 0644);
        if (fd >= 0) {
            char line[256];
            int n = snprintf(line, sizeof line, "loaded pid=%d %s\n", getpid(), getprogname());
            write(fd, line, (size_t)n);
            close(fd);
        }
    }
    (void)sock_fd;
}
