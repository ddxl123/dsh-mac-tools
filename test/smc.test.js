/**
 * SMC sampler tests: normalization and temperature grouping are pure; the live
 * probe runs only on a Mac with the Swift toolchain.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import {
  normalizeSample,
  probeSensors,
  samplerHeaderPath,
  samplerSources,
  summarizeTemperatures,
} from '../src/smc.js'
import { resolveSwiftc } from '../src/swift.js'

test('normalizes a helper sample and drops unusable entries', () => {
  const sample = normalizeSample({
    at: 1761220333000,
    fanCount: 2,
    fans: [
      { index: 1, actualRpm: 1800.04, minRpm: 1000, maxRpm: 4900, mode: 'auto' },
      { index: 0, actualRpm: 2400.06, targetRpm: 2400, mode: 'forced' },
      { index: 'x', actualRpm: 1 },
      { index: 2, actualRpm: 900, mode: 'weird' },
    ],
    temperatures: [
      { key: 'Tp01', celsius: 73.24 },
      { key: 'Tp01', celsius: 99 },
      { key: 'TH0x', celsius: 40.06 },
      { key: 'bad', celsius: 40 },
      { key: 'Tp02', celsius: 400 },
      { key: 'Tp03', celsius: 'warm' },
    ],
  })
  assert.notEqual(sample, null)
  assert.equal(sample.at, 1761220333000)
  assert.equal(sample.fanCount, 2)
  assert.deepEqual(sample.fans.map((fan) => fan.index), [0, 1, 2])
  assert.equal(sample.fans[0].actualRpm, 2400.1)
  assert.equal(sample.fans[0].targetRpm, 2400)
  assert.equal(sample.fans[0].mode, 'forced')
  assert.equal(sample.fans[1].mode, 'auto')
  assert.equal(sample.fans[2].mode, 'unknown')
  assert.deepEqual(sample.temperatures, [
    { key: 'Tp01', celsius: 73.2 },
    { key: 'TH0x', celsius: 40.1 },
  ])
})

test('rejects a helper sample without the expected shape', () => {
  assert.equal(normalizeSample(null), null)
  assert.equal(normalizeSample('nope'), null)
  assert.equal(normalizeSample([1, 2, 3]), null)
  const minimal = normalizeSample({})
  assert.notEqual(minimal, null)
  assert.deepEqual(minimal.fans, [])
  assert.deepEqual(minimal.temperatures, [])
  assert.equal(minimal.fanCount, 0)
})

test('normalizes the IOReport power block', () => {
  const sample = normalizeSample({
    at: 1761220333000,
    power: { cpuW: 13.74, gpuW: 3.55, aneW: 0, dramW: 2.46, socW: 19.74 },
  })
  assert.notEqual(sample, null)
  assert.deepEqual(sample.power, { cpuW: 13.7, gpuW: 3.6, aneW: 0, dramW: 2.5, socW: 19.7 })
})

test('drops the power block when the helper cannot read IOReport', () => {
  for (const power of [undefined, null, 42, 'hot', []]) {
    const sample = normalizeSample({ at: 1, power })
    assert.notEqual(sample, null)
    assert.equal(sample.power, null)
  }
  assert.equal(normalizeSample({ at: 1 }).power, null)
})

test('normalizes partial and invalid power fields independently', () => {
  const sample = normalizeSample({
    at: 1,
    power: { cpuW: 13.7, gpuW: -1, aneW: 'x', dramW: 2000, socW: Number.POSITIVE_INFINITY },
  })
  // The total falls back to the only usable component.
  assert.deepEqual(sample.power, { cpuW: 13.7, gpuW: null, aneW: null, dramW: null, socW: 13.7 })
})

test('keeps a usable socW even when every component is unusable', () => {
  const sample = normalizeSample({
    at: 1,
    power: { cpuW: null, gpuW: undefined, aneW: Number.NaN, dramW: -0.5, socW: 19.84 },
  })
  assert.deepEqual(sample.power, { cpuW: null, gpuW: null, aneW: null, dramW: null, socW: 19.8 })
})

test('drops the power block when every field is unusable', () => {
  const sample = normalizeSample({
    at: 1,
    power: { cpuW: null, gpuW: -2, aneW: 'x', dramW: 1001, socW: Number.POSITIVE_INFINITY },
  })
  assert.equal(sample.power, null)
})

test('groups temperatures by SMC family and curates the detail list', () => {
  const readings = [
    { key: 'Tp01', celsius: 70 },
    { key: 'Tp0X', celsius: 88.4 },
    { key: 'Te0L', celsius: 62 },
    { key: 'Tg0L', celsius: 59 },
    { key: 'TH0x', celsius: 40 },
    { key: 'Tm0P', celsius: 48 },
    { key: 'TW0P', celsius: 33.5 },
    { key: 'Ta0p', celsius: 41.2 },
    { key: 'Tz11', celsius: 0 },
    { key: 'TCMz', celsius: 93 },
  ]
  const summary = summarizeTemperatures(readings)
  assert.equal(summary.groups.cpuPerformance, 88.4)
  assert.equal(summary.groups.cpuEfficiency, 62)
  assert.equal(summary.groups.gpu, 59)
  assert.equal(summary.groups.ssd, 40)
  assert.equal(summary.groups.memory, 48)
  assert.equal(summary.groups.wifi, 33.5)
  assert.equal(summary.groups.battery, null)
  assert.equal(summary.groups.ambient, 41.2)
  assert.deepEqual(summary.readings.map((reading) => reading.key).slice(0, 3), ['Tp0X', 'Tp01', 'Te0L'])
  assert.equal(summary.hidden, 2)
})

test('ambient group stays null without a board sensor reading', () => {
  const summary = summarizeTemperatures([
    { key: 'Tp01', celsius: 70 },
    { key: 'Ta00', celsius: 0 },
    { key: 'Ta04', celsius: 0 },
  ])
  assert.equal(summary.groups.ambient, null)
})

test('ambient group ignores unpopulated zero keys and keeps the real board sensor', () => {
  const summary = summarizeTemperatures([
    { key: 'Ta00', celsius: 0 },
    { key: 'Ta04', celsius: 0 },
    { key: 'Ta0p', celsius: 48.9 },
  ])
  assert.equal(summary.groups.ambient, 48.9)
})

test('the helper sources and bridging header exist on disk', () => {
  for (const path of samplerSources()) assert.ok(existsSync(path), `missing ${path}`)
  assert.ok(existsSync(samplerHeaderPath()), `missing ${samplerHeaderPath()}`)
})

test('probes a real sample on this Mac', { skip: process.platform !== 'darwin' || resolveSwiftc() === undefined }, async () => {
  const sample = await probeSensors()
  assert.ok(Number.isInteger(sample.fanCount) && sample.fanCount >= 0)
  assert.ok(Array.isArray(sample.temperatures))
  assert.ok(sample.temperatures.length > 0, 'expected at least one temperature reading')
  for (const reading of sample.temperatures) {
    assert.match(reading.key, /^[A-Za-z0-9]{4}$/u)
    assert.ok(reading.celsius > -40 && reading.celsius < 200)
  }
  for (const fan of sample.fans) {
    if (fan.minRpm !== null && fan.maxRpm !== null) assert.ok(fan.maxRpm >= fan.minRpm)
  }
  // IOReport's Energy Model group exists on Apple Silicon; the helper degrades
  // to `power: null` on Intel, where the probe is expected to skip anyway.
  if (process.arch === 'arm64') {
    assert.notEqual(sample.power, null, 'expected an IOReport power reading')
    for (const field of ['cpuW', 'gpuW', 'aneW', 'dramW', 'socW']) {
      assert.ok(sample.power[field] === null || (sample.power[field] >= 0 && sample.power[field] <= 1000))
    }
    assert.ok(sample.power.socW > 0, 'expected a non-zero SoC power total')
  }
})
