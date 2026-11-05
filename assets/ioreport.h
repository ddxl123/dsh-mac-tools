/*
 * dsh-mac-tools — SoC power sampling through IOReport (see ioreport.c).
 *
 * The IOReport "Energy Model" group exposes cumulative per-block energy
 * counters; power is the difference between two samples divided by the elapsed
 * time. IOReport is a private framework, so the shim loads it at runtime and
 * reports "unavailable" instead of crashing when it is missing (Intel Macs, or
 * a future macOS that moves the library).
 *
 * Single-threaded use only: the shim keeps one static subscription and one
 * previous sample.
 */

#ifndef DSH_IOREPORT_H
#define DSH_IOREPORT_H

/* One SoC power reading in watts; `socW` is the sum of the four blocks. */
typedef struct {
    double cpuW;
    double gpuW;
    double aneW;
    double dramW;
} DshPowerSample;

/* Subscribe to the Energy Model counters and take the baseline sample.
 * Returns 1 on success, 0 when IOReport is missing or the setup fails. */
int dsh_power_init(void);

/* Fill `out` from the energy delta since the previous sample.
 * Returns 1 when the reading is valid, 0 when IOReport is unavailable, when
 * the first call after init only records the baseline, or when the elapsed
 * interval is still too short to divide by. */
int dsh_power_sample(DshPowerSample *out);

#endif /* DSH_IOREPORT_H */
