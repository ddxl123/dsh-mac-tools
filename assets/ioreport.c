/*
 * dsh-mac-tools — IOReport energy shim.
 *
 * IOReport is a private framework: no headers ship with the SDK, so the
 * handful of functions used here are declared with the signatures the shipped
 * dylib exposes and resolved through dlopen/dlsym. That keeps the build
 * independent of a private SDK, and a Mac without the framework (Intel) simply
 * reports "unavailable" instead of failing to compile or crashing at runtime.
 *
 * Flow (all CoreFoundation, manual reference counting):
 *   channels = IOReportCopyChannelsInGroup("Energy Model")
 *   subscription, subscribed = IOReportCreateSubscription(channels)
 *   baseline = IOReportCreateSamples(subscription, subscribed)
 *   ... one interval later ...
 *   current  = IOReportCreateSamples(subscription, subscribed)
 *   delta    = IOReportCreateSamplesDelta(baseline, current)
 *   power_W  = sum(delta energy joules) / elapsed seconds
 */

#include "ioreport.h"

#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <stdint.h>
#include <string.h>
#include <time.h>

/* Private IOReport ABI, taken from the signatures the dylib is called with. */
typedef CFMutableDictionaryRef (*DshCopyChannelsInGroup)(
    CFStringRef group, CFStringRef subgroup, uint64_t channelId, uint64_t flags, uint64_t options);
typedef CFTypeRef (*DshCreateSubscription)(
    void *allocator, CFMutableDictionaryRef channels, CFMutableDictionaryRef *subscribed,
    uint64_t flags, CFTypeRef options);
typedef CFDictionaryRef (*DshCreateSamples)(
    CFTypeRef subscription, CFMutableDictionaryRef subscribed, CFTypeRef options);
typedef CFDictionaryRef (*DshCreateSamplesDelta)(
    CFDictionaryRef first, CFDictionaryRef second, CFTypeRef options);
typedef int32_t (*DshSimpleGetIntegerValue)(CFDictionaryRef channel, int32_t index);
typedef CFStringRef (*DshChannelGetChannelName)(CFDictionaryRef channel);
typedef CFStringRef (*DshChannelGetUnitLabel)(CFDictionaryRef channel);

/* One interval shorter than this cannot produce a meaningful rate: the energy
 * counters are integers and the sampler may call us twice in a row. */
#define DSH_MIN_INTERVAL_SECONDS 0.1

static void *g_library = NULL;
static DshCopyChannelsInGroup g_copyChannelsInGroup = NULL;
static DshCreateSubscription g_createSubscription = NULL;
static DshCreateSamples g_createSamples = NULL;
static DshCreateSamplesDelta g_createSamplesDelta = NULL;
static DshSimpleGetIntegerValue g_simpleGetIntegerValue = NULL;
static DshChannelGetChannelName g_channelGetChannelName = NULL;
static DshChannelGetUnitLabel g_channelGetUnitLabel = NULL;

/* The channel dictionary is kept alive for the process lifetime: the
 * subscription is built from it, and releasing it while the subscription still
 * refers to it would be a use-after-free for a one-time allocation. */
static CFMutableDictionaryRef g_channels = NULL;
static CFTypeRef g_subscription = NULL;
static CFMutableDictionaryRef g_subscribed = NULL;
static CFDictionaryRef g_previous = NULL;
static double g_previousSeconds = 0.0;
static int g_ready = 0;

/* Monotonic clock: energy divided by wall-clock time would drift when the
 * system clock is adjusted mid-run. */
static double dsh_monotonic_seconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0.0;
    return (double)now.tv_sec + (double)now.tv_nsec / 1e9;
}

/* Release everything owned; the dlopen handle stays open so a failed init can
 * be retried without reopening the framework. */
static void dsh_release_objects(void) {
    if (g_previous != NULL) {
        CFRelease(g_previous);
        g_previous = NULL;
    }
    if (g_subscribed != NULL) {
        CFRelease(g_subscribed);
        g_subscribed = NULL;
    }
    if (g_subscription != NULL) {
        CFRelease(g_subscription);
        g_subscription = NULL;
    }
    if (g_channels != NULL) {
        CFRelease(g_channels);
        g_channels = NULL;
    }
    g_previousSeconds = 0.0;
    g_ready = 0;
}

/* Resolve the framework and its symbols once. */
static int dsh_load_symbols(void) {
    if (g_library == NULL) {
        g_library = dlopen("/usr/lib/libIOReport.dylib", RTLD_NOW);
        if (g_library == NULL) return 0;
    }
    g_copyChannelsInGroup = (DshCopyChannelsInGroup)dlsym(g_library, "IOReportCopyChannelsInGroup");
    g_createSubscription = (DshCreateSubscription)dlsym(g_library, "IOReportCreateSubscription");
    g_createSamples = (DshCreateSamples)dlsym(g_library, "IOReportCreateSamples");
    g_createSamplesDelta = (DshCreateSamplesDelta)dlsym(g_library, "IOReportCreateSamplesDelta");
    g_simpleGetIntegerValue = (DshSimpleGetIntegerValue)dlsym(g_library, "IOReportSimpleGetIntegerValue");
    g_channelGetChannelName = (DshChannelGetChannelName)dlsym(g_library, "IOReportChannelGetChannelName");
    /* Optional: without the unit label we assume millijoules, which is what
     * the Energy Model group reports on Apple Silicon. */
    g_channelGetUnitLabel = (DshChannelGetUnitLabel)dlsym(g_library, "IOReportChannelGetUnitLabel");
    if (g_copyChannelsInGroup == NULL || g_createSubscription == NULL || g_createSamples == NULL
        || g_createSamplesDelta == NULL || g_simpleGetIntegerValue == NULL
        || g_channelGetChannelName == NULL) {
        dlclose(g_library);
        g_library = NULL;
        return 0;
    }
    return 1;
}

/* Convert one counter to joules. The label is checked rather than assumed so a
 * future unit change cannot inflate the reported watts. */
static double dsh_joules(int64_t value, CFDictionaryRef channel) {
    double scale = 1e-3; /* millijoules, the Energy Model default */
    if (g_channelGetUnitLabel != NULL) {
        CFStringRef label = g_channelGetUnitLabel(channel);
        if (label != NULL) {
            char text[16];
            if (CFStringGetCString(label, text, sizeof(text), kCFStringEncodingUTF8)) {
                if (strcmp(text, "J") == 0) {
                    scale = 1.0;
                } else if (strcmp(text, "mJ") == 0) {
                    scale = 1e-3;
                } else if (strcmp(text, "uJ") == 0) {
                    scale = 1e-6;
                } else if (strcmp(text, "nJ") == 0) {
                    scale = 1e-9;
                }
            }
        }
    }
    return (double)value * scale;
}

/* Accumulate the four blocks of interest from a delta sample. Returns 0 when
 * none of them was present (an IOReport layout change we cannot read). */
static int dsh_read_delta(CFDictionaryRef delta, double seconds, DshPowerSample *out) {
    CFTypeRef value = CFDictionaryGetValue(delta, CFSTR("IOReportChannels"));
    if (value == NULL || CFGetTypeID(value) != CFArrayGetTypeID()) return 0;
    CFArrayRef channels = (CFArrayRef)value;
    double cpuJ = 0.0;
    double gpuJ = 0.0;
    double aneJ = 0.0;
    double dramJ = 0.0;
    int matched = 0;
    CFIndex count = CFArrayGetCount(channels);
    for (CFIndex index = 0; index < count; index++) {
        CFTypeRef entry = CFArrayGetValueAtIndex(channels, index);
        if (entry == NULL || CFGetTypeID(entry) != CFDictionaryGetTypeID()) continue;
        CFDictionaryRef channel = (CFDictionaryRef)entry;
        CFStringRef name = g_channelGetChannelName(channel);
        if (name == NULL) continue;
        char text[64];
        if (!CFStringGetCString(name, text, sizeof(text), kCFStringEncodingUTF8)) continue;
        /* "GPU Energy" is an nJ duplicate of "GPU"; match the exact names so
         * the same energy is never counted twice. */
        double *bucket = NULL;
        if (strcmp(text, "CPU Energy") == 0) {
            bucket = &cpuJ;
        } else if (strcmp(text, "GPU") == 0) {
            bucket = &gpuJ;
        } else if (strcmp(text, "ANE") == 0) {
            bucket = &aneJ;
        } else if (strcmp(text, "DRAM") == 0) {
            bucket = &dramJ;
        }
        if (bucket == NULL) continue;
        int64_t energy = g_simpleGetIntegerValue(channel, 0);
        if (energy < 0) continue;
        *bucket += dsh_joules(energy, channel);
        matched += 1;
    }
    if (matched == 0) return 0;
    out->cpuW = cpuJ / seconds;
    out->gpuW = gpuJ / seconds;
    out->aneW = aneJ / seconds;
    out->dramW = dramJ / seconds;
    return 1;
}

int dsh_power_init(void) {
    if (g_ready) return 1;
    if (!dsh_load_symbols()) return 0;
    g_channels = g_copyChannelsInGroup(CFSTR("Energy Model"), NULL, 0, 0, 0);
    if (g_channels == NULL) return 0;
    g_subscribed = NULL;
    g_subscription = g_createSubscription(NULL, g_channels, &g_subscribed, 0, NULL);
    if (g_subscription == NULL || g_subscribed == NULL) {
        dsh_release_objects();
        return 0;
    }
    g_previous = g_createSamples(g_subscription, g_subscribed, NULL);
    if (g_previous == NULL) {
        dsh_release_objects();
        return 0;
    }
    g_previousSeconds = dsh_monotonic_seconds();
    g_ready = 1;
    return 1;
}

int dsh_power_sample(DshPowerSample *out) {
    if (!g_ready || out == NULL) return 0;
    memset(out, 0, sizeof(*out));
    CFDictionaryRef current = g_createSamples(g_subscription, g_subscribed, NULL);
    if (current == NULL) return 0;
    double now = dsh_monotonic_seconds();
    double elapsed = now - g_previousSeconds;
    if (elapsed < DSH_MIN_INTERVAL_SECONDS) {
        /* Too soon after the baseline: the counters have not moved enough to
         * divide by. Move the baseline forward and report "not yet". */
        CFRelease(g_previous);
        g_previous = current;
        g_previousSeconds = now;
        return 0;
    }
    CFDictionaryRef delta = g_createSamplesDelta(g_previous, current, NULL);
    CFRelease(g_previous);
    g_previous = current;
    g_previousSeconds = now;
    if (delta == NULL) return 0;
    int valid = dsh_read_delta(delta, elapsed, out);
    CFRelease(delta);
    return valid;
}
