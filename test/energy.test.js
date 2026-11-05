/**
 * Daily energy ledger tests.
 *
 * The ledger is small bookkeeping around one JSON file, so every test runs
 * against a throwaway state directory and an injected clock. The pure date
 * helpers are exercised directly: the panel's date-range UI and the midnight
 * rollover both depend on them matching the local calendar exactly.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  addDays,
  daySpan,
  EnergyLedger,
  isDateKey,
  isPricePerKwh,
  localDateKey,
  todayDateKey,
} from '../src/energy.js'

/**
 * Local epoch milliseconds for one calendar date/time, independent of the
 * machine's time zone.
 *
 * @param {number} year - full year.
 * @param {number} monthIndex - 0-based month.
 * @param {number} day - day of month.
 * @param {number} [hours] - hour of day.
 * @returns {number} epoch milliseconds.
 */
function localMs(year, monthIndex, day, hours = 12) {
  return new Date(year, monthIndex, day, hours, 0, 0, 0).getTime()
}

/**
 * A throwaway plugin state directory.
 *
 * @returns {{ directory: string, statePath: string, cleanup: () => void }} the fixture.
 */
function createState() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-energy-test-'))
  return {
    directory,
    statePath: join(directory, 'monitor', 'energy.json'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  }
}

test('local date keys follow the local calendar', () => {
  assert.equal(localDateKey(localMs(2026, 10, 5)), '2026-11-05')
  assert.equal(localDateKey(localMs(2026, 0, 1, 0)), '2026-01-01')
  assert.equal(localDateKey(localMs(2026, 11, 31, 23)), '2026-12-31')
  assert.equal(todayDateKey(localMs(2026, 10, 5)), '2026-11-05')
  assert.equal(localDateKey(Number.NaN), '')
  assert.equal(localDateKey(Number.POSITIVE_INFINITY), '')
  assert.equal(localDateKey('not a clock'), '')
})

test('isDateKey accepts real calendar dates only', () => {
  assert.equal(isDateKey('2026-11-05'), true)
  assert.equal(isDateKey('2024-02-29'), true, 'leap day')
  assert.equal(isDateKey('2026-02-30'), false)
  assert.equal(isDateKey('2025-02-29'), false, '2025 is not a leap year')
  assert.equal(isDateKey('2026-13-01'), false)
  assert.equal(isDateKey('2026-00-10'), false)
  assert.equal(isDateKey('2026-11-00'), false)
  assert.equal(isDateKey('2026-1-05'), false, 'the contract wants two-digit fields')
  assert.equal(isDateKey('2026-11-05T00:00:00.000Z'), false)
  assert.equal(isDateKey('0000-01-01'), false)
  assert.equal(isDateKey(''), false)
  assert.equal(isDateKey(null), false)
  assert.equal(isDateKey(20_261_105), false)
  assert.equal(isDateKey(new Date()), false)
})

test('addDays walks month, year and leap-day boundaries', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
  assert.equal(addDays('2024-02-28', 1), '2024-02-29')
  assert.equal(addDays('2023-02-28', 1), '2023-03-01')
  assert.equal(addDays('2026-11-05', 0), '2026-11-05')
  assert.equal(addDays('2026-11-05', -6), '2026-10-30')
  assert.equal(addDays('2026-11-05', 30), '2026-12-05')
  assert.equal(addDays('2026-02-30', 1), '', 'an unreal date is not shifted')
  assert.equal(addDays('', 1), '')
  assert.equal(addDays('2026-11-05', 1.5), '')
})

test('daySpan counts inclusive calendar days', () => {
  assert.equal(daySpan('2026-11-05', '2026-11-05'), 1)
  assert.equal(daySpan('2026-10-30', '2026-11-05'), 7)
  assert.equal(daySpan('2024-01-01', '2024-12-31'), 366, 'a leap year is 366 days')
  assert.equal(daySpan('2026-11-05', '2026-11-01'), 0)
  assert.equal(daySpan('2026-02-30', '2026-03-01'), 0)
  assert.equal(daySpan('', ''), 0)
})

test('record buckets energy by local date and rolls over at midnight', () => {
  const state = createState()
  const clock = { value: localMs(2026, 9, 31, 23) }
  const ledger = new EnergyLedger({ statePath: state.statePath, now: () => clock.value, warn: () => {} })
  try {
    ledger.record(10, clock.value)
    assert.deepEqual(ledger.snapshot(), {
      todayWh: 10, totalWh: 10, days: 1, since: '2026-10-31',
      pricePerKwh: 0.5, costToday: 0.005, costTotal: 0.005,
    })
    ledger.record(5.5, clock.value)
    assert.equal(ledger.snapshot().todayWh, 15.5, 'same-day records add up')

    // Cross local midnight: the new bucket becomes "today" and the old one
    // stays in the total.
    clock.value = localMs(2026, 10, 1, 0)
    ledger.record(2, clock.value)
    assert.deepEqual(ledger.snapshot(), {
      todayWh: 2, totalWh: 17.5, days: 2, since: '2026-10-31',
      pricePerKwh: 0.5, costToday: 0.001, costTotal: 0.0088,
    })
  } finally {
    state.cleanup()
  }
})

test('record ignores missing, non-finite and negative watt-hours', () => {
  const clock = { value: localMs(2026, 10, 5) }
  const ledger = new EnergyLedger({ now: () => clock.value })
  ledger.record(Number.NaN, clock.value)
  ledger.record(Number.POSITIVE_INFINITY, clock.value)
  ledger.record(-4, clock.value)
  ledger.record('abc', clock.value)
  ledger.record(undefined, clock.value)
  assert.deepEqual(ledger.snapshot(), {
    todayWh: 0, totalWh: 0, days: 0, since: null,
    pricePerKwh: 0.5, costToday: 0, costTotal: 0,
  })

  ledger.record(1.23456, clock.value)
  assert.equal(ledger.snapshot().todayWh, 1.2346, 'buckets are rounded to four decimals')
  ledger.record(0.00004, clock.value)
  assert.equal(ledger.snapshot().todayWh, 1.2346, 'an increment below the stored precision changes nothing')
})

test('the ledger persists its daily buckets atomically and reloads them', () => {
  const state = createState()
  const clock = { value: localMs(2026, 10, 4) }
  const ledger = new EnergyLedger({ statePath: state.statePath, now: () => clock.value, warn: () => {} })
  try {
    ledger.record(12.3456, clock.value)
    ledger.record(0.0001, clock.value)
    clock.value = localMs(2026, 10, 5)
    ledger.record(3, clock.value)
    ledger.dispose()

    const file = JSON.parse(readFileSync(state.statePath, 'utf8'))
    assert.equal(file.version, 1)
    assert.equal(typeof file.updatedAt, 'string')
    assert.equal(file.pricePerKwh, 0.5, 'the default price is written with the buckets')
    assert.deepEqual(file.days, { '2026-11-04': 12.3457, '2026-11-05': 3 })
    assert.equal(statSync(state.statePath).mode & 0o777, 0o600, 'the state file is private')

    const reloaded = new EnergyLedger({ statePath: state.statePath, now: () => clock.value, warn: () => {} })
    assert.deepEqual(reloaded.snapshot(), {
      todayWh: 3, totalWh: 15.3457, days: 2, since: '2026-11-04',
      pricePerKwh: 0.5, costToday: 0.0015, costTotal: 0.0077,
    })
    // A reload keeps accumulating instead of starting over.
    reloaded.record(1, clock.value)
    assert.equal(reloaded.snapshot().todayWh, 4)
  } finally {
    state.cleanup()
  }
})

test('a corrupt or unreadable ledger becomes empty and warns', () => {
  const state = createState()
  const now = () => localMs(2026, 10, 10)
  mkdirSync(join(state.directory, 'monitor'), { recursive: true })
  writeFileSync(state.statePath, '{ this is not json', 'utf8')

  const warnings = []
  const warn = (message) => warnings.push(message)
  const corrupt = new EnergyLedger({ statePath: state.statePath, now, warn })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /parse the energy ledger/u)
  assert.deepEqual(corrupt.snapshot(), {
    todayWh: 0, totalWh: 0, days: 0, since: null,
    pricePerKwh: 0.5, costToday: 0, costTotal: 0,
  })
  // A corrupt file can be replaced: recording works and the next flush wins.
  corrupt.record(2, localMs(2026, 10, 5))
  corrupt.dispose()
  assert.equal(JSON.parse(readFileSync(state.statePath, 'utf8')).days['2026-11-05'], 2)

  writeFileSync(state.statePath, JSON.stringify({ version: 1, days: 'nope' }), 'utf8')
  const wrongShape = new EnergyLedger({ statePath: state.statePath, now, warn })
  assert.deepEqual(wrongShape.snapshot(), {
    todayWh: 0, totalWh: 0, days: 0, since: null,
    pricePerKwh: 0.5, costToday: 0, costTotal: 0,
  })

  writeFileSync(state.statePath, JSON.stringify({ version: 99, days: { '2026-11-05': 1 } }), 'utf8')
  const futureVersion = new EnergyLedger({ statePath: state.statePath, now, warn })
  assert.equal(futureVersion.snapshot().days, 0)

  // A directory where a file is expected is "unreadable" on every platform.
  const unreadable = new EnergyLedger({ statePath: state.directory, now, warn })
  assert.equal(unreadable.snapshot().days, 0)

  // Invalid individual entries are dropped instead of poisoning the ledger.
  writeFileSync(state.statePath, JSON.stringify({
    version: 1,
    days: { '2026-11-05': 2.5, '2026-02-30': 1, bad: 2, '2026-11-06': -1, '2026-11-07': 'x' },
  }), 'utf8')
  const mixed = new EnergyLedger({ statePath: state.statePath, now, warn })
  assert.deepEqual(mixed.snapshot(), {
    todayWh: 0, totalWh: 2.5, days: 1, since: '2026-11-05',
    pricePerKwh: 0.5, costToday: 0, costTotal: 0.0013,
  })

  // A missing state file is the normal first run: no warning.
  const fresh = new EnergyLedger({ statePath: join(state.directory, 'missing', 'energy.json'), now, warn: () => { throw new Error('no warning expected') } })
  assert.equal(fresh.snapshot().days, 0)

  state.cleanup()
})

test('retention keeps only the newest days', () => {
  const now = () => localMs(2026, 10, 5)
  const ledger = new EnergyLedger({ now, retentionDays: 3 })
  for (let index = 0; index < 5; index += 1) ledger.record(1, localMs(2026, 0, 1 + index))
  assert.deepEqual(ledger.snapshot(), {
    todayWh: 0, totalWh: 3, days: 3, since: '2026-01-03',
    pricePerKwh: 0.5, costToday: 0, costTotal: 0.0015,
  })

  // Pruning sorts by date, not by insertion order.
  const shuffled = new EnergyLedger({ now, retentionDays: 2 })
  shuffled.record(1, localMs(2026, 0, 5))
  shuffled.record(1, localMs(2026, 0, 3))
  assert.equal(shuffled.snapshot().days, 2)
  shuffled.record(1, localMs(2026, 0, 4))
  assert.deepEqual(shuffled.snapshot(), {
    todayWh: 0, totalWh: 2, days: 2, since: '2026-01-04',
    pricePerKwh: 0.5, costToday: 0, costTotal: 0.001,
  })
})

test('query fills missing days and defaults to the last seven', () => {
  const clock = { value: localMs(2026, 10, 5) }
  const ledger = new EnergyLedger({ now: () => clock.value })
  ledger.record(10, localMs(2026, 10, 1))
  ledger.record(5, localMs(2026, 10, 3))
  ledger.record(2, localMs(2026, 10, 5))

  const range = ledger.query({ from: '2026-11-01', to: '2026-11-05' })
  assert.equal(range.from, '2026-11-01')
  assert.equal(range.to, '2026-11-05')
  assert.deepEqual(range.days, [
    { date: '2026-11-01', wh: 10 },
    { date: '2026-11-02', wh: 0 },
    { date: '2026-11-03', wh: 5 },
    { date: '2026-11-04', wh: 0 },
    { date: '2026-11-05', wh: 2 },
  ])
  assert.equal(range.totalWh, 17)
  assert.equal(range.averageWh, 3.4)

  const defaulted = ledger.query()
  assert.equal(defaulted.from, '2026-10-30', 'from defaults to to − 6 days')
  assert.equal(defaulted.to, '2026-11-05', 'to defaults to today')
  assert.equal(defaulted.days.length, 7)
  assert.equal(defaulted.days[defaulted.days.length - 1].date, '2026-11-05')

  const toOnly = ledger.query({ to: '2026-11-02' })
  assert.equal(toOnly.from, '2026-10-27')
  assert.equal(toOnly.days.length, 7)

  const fromOnly = ledger.query({ from: '2026-11-03' })
  assert.equal(fromOnly.to, '2026-11-05')
  assert.equal(fromOnly.days.length, 3)

  const empty = ledger.query({ from: '2026-11-05', to: '2026-11-01' })
  assert.deepEqual(empty, {
    from: '2026-11-05', to: '2026-11-01', days: [], totalWh: 0, averageWh: 0,
    pricePerKwh: 0.5, totalCost: 0, averageCost: 0,
  })

  // Days outside the query window stay out even though the ledger retains them.
  assert.equal(ledger.query({ from: '2026-10-01', to: '2026-10-02' }).totalWh, 0)
})

test('query averages repeating decimals at four decimals', () => {
  const clock = { value: localMs(2026, 10, 5) }
  const ledger = new EnergyLedger({ now: () => clock.value })
  ledger.record(1, localMs(2026, 10, 4))
  const range = ledger.query({ from: '2026-11-04', to: '2026-11-06' })
  assert.equal(range.totalWh, 1)
  assert.equal(range.averageWh, 0.3333, '1 Wh over three days does not leak float noise')
})

test('flush is throttled, but a day rollover and dispose always write', () => {
  const state = createState()
  const clock = { value: new Date(2026, 10, 5, 23, 59, 50).getTime() }
  const ledger = new EnergyLedger({
    statePath: state.statePath,
    now: () => clock.value,
    flushIntervalMs: 60_000,
    warn: () => {},
  })
  try {
    ledger.record(1, clock.value)
    assert.deepEqual(JSON.parse(readFileSync(state.statePath, 'utf8')).days, { '2026-11-05': 1 }, 'the first record persists right away')

    clock.value += 5_000
    ledger.record(2, clock.value)
    assert.deepEqual(JSON.parse(readFileSync(state.statePath, 'utf8')).days, { '2026-11-05': 1 }, 'writes stay inside the throttle window')

    // 15 s later at 00:00:05 — well inside the throttle — but the local day
    // changed, so the ledger must flush immediately.
    clock.value = new Date(2026, 10, 6, 0, 0, 5).getTime()
    ledger.record(3, clock.value)
    assert.deepEqual(JSON.parse(readFileSync(state.statePath, 'utf8')).days, {
      '2026-11-05': 3,
      '2026-11-06': 3,
    })

    clock.value += 5_000
    ledger.record(4, clock.value)
    ledger.dispose()
    assert.deepEqual(JSON.parse(readFileSync(state.statePath, 'utf8')).days, {
      '2026-11-05': 3,
      '2026-11-06': 7,
    })
  } finally {
    state.cleanup()
  }
})

test('an in-memory ledger never touches the disk', () => {
  const ledger = new EnergyLedger({ now: () => localMs(2026, 10, 5) })
  ledger.record(5, localMs(2026, 10, 5))
  ledger.flush()
  ledger.dispose()
  assert.equal(ledger.snapshot().todayWh, 5)
  assert.equal(ledger.statePath, undefined)
})

test('the electricity price defaults to 0.5 for old and invalid ledgers', () => {
  const state = createState()
  const now = () => localMs(2026, 10, 5)
  const warnings = []
  const warn = (message) => warnings.push(message)
  mkdirSync(join(state.directory, 'monitor'), { recursive: true })
  try {
    // Files written before the price field existed stay valid: the operator
    // simply has not set a price yet, so the documented default applies.
    writeFileSync(state.statePath, JSON.stringify({ version: 1, days: { '2026-11-05': 1000 } }), 'utf8')
    const legacy = new EnergyLedger({ statePath: state.statePath, now, warn })
    const legacySummary = legacy.snapshot()
    assert.equal(legacySummary.pricePerKwh, 0.5)
    assert.equal(legacySummary.costToday, 0.5, '1000 Wh at 0.5 元/度 costs 0.5 元')
    assert.equal(legacySummary.costTotal, 0.5)
    assert.deepEqual(warnings, [], 'an absent price is not a warning')

    // A present but unusable value falls back to the default with a warning;
    // the buckets themselves must still load.
    for (const invalid of [-1, 100.5, '0.56', null, true]) {
      writeFileSync(state.statePath, JSON.stringify({ version: 1, days: { '2026-11-05': 1000 }, pricePerKwh: invalid }), 'utf8')
      warnings.length = 0
      const ledger = new EnergyLedger({ statePath: state.statePath, now, warn })
      assert.equal(ledger.snapshot().pricePerKwh, 0.5)
      assert.equal(ledger.snapshot().totalWh, 1000, 'the buckets survive a bad price')
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /invalid pricePerKwh/u)
    }
  } finally {
    state.cleanup()
  }
})

test('setPrice persists the price immediately and survives a reload', () => {
  const state = createState()
  const clock = { value: localMs(2026, 10, 5) }
  try {
    const ledger = new EnergyLedger({
      statePath: state.statePath,
      now: () => clock.value,
      flushIntervalMs: 60_000,
      warn: () => {},
    })
    ledger.record(1000, clock.value)
    const saved = ledger.setPrice(0.56)
    assert.equal(saved.pricePerKwh, 0.56)
    assert.equal(saved.costToday, 0.56)

    // The save lands well inside the flush throttle window, yet must be on
    // disk before the call returns: the operator just confirmed the setting.
    const file = JSON.parse(readFileSync(state.statePath, 'utf8'))
    assert.equal(file.pricePerKwh, 0.56)
    assert.deepEqual(file.days, { '2026-11-05': 1000 })

    const reloaded = new EnergyLedger({ statePath: state.statePath, now: () => clock.value, warn: () => {} })
    assert.equal(reloaded.snapshot().pricePerKwh, 0.56)
    assert.equal(reloaded.snapshot().costTotal, 0.56)
  } finally {
    state.cleanup()
  }
})

test('setPrice accepts only finite numbers in [0, 100]', () => {
  const ledger = new EnergyLedger({ now: () => localMs(2026, 10, 5) })
  assert.equal(ledger.snapshot().pricePerKwh, 0.5, 'the default is 0.5 元/度')
  for (const invalid of [-0.01, 100.01, Number.NaN, Number.POSITIVE_INFINITY, '0.56', null, undefined, {}]) {
    assert.equal(ledger.setPrice(invalid), null, `${String(invalid)} is refused`)
  }
  assert.equal(ledger.snapshot().pricePerKwh, 0.5, 'a refused price changes nothing')

  assert.equal(isPricePerKwh(0), true, 'a free tariff is valid')
  assert.equal(isPricePerKwh(0.56), true)
  assert.equal(isPricePerKwh(100), true)
  assert.equal(isPricePerKwh(-1), false)
  assert.equal(isPricePerKwh(101), false)
  assert.equal(isPricePerKwh('0.56'), false, 'numeric strings are not coerced')

  assert.equal(ledger.setPrice(0).pricePerKwh, 0)
  assert.equal(ledger.snapshot().costTotal, 0, 'a zero price bills nothing')
  assert.equal(ledger.setPrice(100).pricePerKwh, 100)
})

test('snapshot and query convert watt-hours to 电费 at four decimals', () => {
  const clock = { value: localMs(2026, 10, 5) }
  const ledger = new EnergyLedger({ now: () => clock.value })
  ledger.record(1000, clock.value)
  const summary = ledger.snapshot()
  assert.equal(summary.pricePerKwh, 0.5)
  assert.equal(summary.costToday, 0.5, '1000 Wh at 0.5 元/度 = 0.5 元')
  assert.equal(summary.costTotal, 0.5)

  // 2000 Wh at 0.56 元/度 = 1.12 元.
  ledger.setPrice(0.56)
  ledger.record(1000, clock.value)
  assert.equal(ledger.snapshot().costTotal, 1.12)
  assert.equal(ledger.snapshot().costToday, 1.12)

  const range = ledger.query({ from: '2026-11-05', to: '2026-11-05' })
  assert.equal(range.pricePerKwh, 0.56)
  assert.equal(range.totalWh, 2000)
  assert.equal(range.totalCost, 1.12)
  assert.equal(range.averageCost, 1.12)

  // Rounding to the contract's four decimals: 1 Wh at 0.5 元/度 is 0.0005 元,
  // while the daily average of 0.3333 Wh at the same price is 0.00016665 元.
  const rounding = new EnergyLedger({ now: () => clock.value })
  rounding.record(1, localMs(2026, 10, 4))
  const averaged = rounding.query({ from: '2026-11-04', to: '2026-11-06' })
  assert.equal(averaged.totalWh, 1)
  assert.equal(averaged.totalCost, 0.0005)
  assert.equal(averaged.averageWh, 0.3333)
  assert.equal(averaged.averageCost, 0.0002)

  // A price with more decimals still rounds the money to four decimals.
  rounding.setPrice(0.3333)
  assert.equal(rounding.query({ from: '2026-11-04', to: '2026-11-04' }).totalCost, 0.0003)
})
