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

test('groups temperatures by SMC family and curates the detail list', () => {
  const readings = [
    { key: 'Tp01', celsius: 70 },
    { key: 'Tp0X', celsius: 88.4 },
    { key: 'Te0L', celsius: 62 },
    { key: 'Tg0L', celsius: 59 },
    { key: 'TH0x', celsius: 40 },
    { key: 'Tm0P', celsius: 48 },
    { key: 'TW0P', celsius: 33.5 },
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
  assert.equal(summary.groups.ambient, null)
  assert.deepEqual(summary.readings.map((reading) => reading.key).slice(0, 3), ['Tp0X', 'Tp01', 'Te0L'])
  assert.equal(summary.hidden, 2)
})

test('the helper sources exist on disk', () => {
  for (const path of samplerSources()) assert.ok(existsSync(path), `missing ${path}`)
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
})
