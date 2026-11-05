/**
 * The persisted daily energy ledger behind the panel's 能耗统计 section.
 *
 * The monitor already integrates SoC wattage into a session counter
 * (`power.energyWh`); that counter dies with the plugin. This module buckets
 * the same watt-hours into local calendar days and keeps them in a small JSON
 * document under the plugin state directory, so the panel can answer "how many
 * kWh did this Mac use today / this week / this month" across reloads and DSH
 * restarts.
 *
 * The same document also carries the operator's electricity price (元/度): the
 * panel's 电费 lines are meaningless without it, and living beside the buckets
 * means one atomic write and one load path for both.
 *
 * Dates are **local** on purpose: the operator thinks in "today", and the
 * ledger, the query defaults and the day rollover must all agree on the same
 * boundary. The pure date helpers are exported because the dispatcher
 * (`src/ops.js`) validates panel-supplied ranges (and the price) with them.
 *
 * The ledger is best-effort by design: a missing, unreadable or corrupt state
 * file degrades to an empty ledger and a warning; it never throws into the
 * sampling loop, and a write failure keeps the in-memory data for a retry.
 *
 * @module dsh-mac-tools/energy
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Persistence format version written to (and accepted from) `energy.json`. */
export const ENERGY_LEDGER_VERSION = 1

/** Days of history kept by default: covers the panel's 366-day custom range plus a margin. */
export const DEFAULT_RETENTION_DAYS = 400

/** Minimum delay between two throttled flushes of the ledger file. */
export const DEFAULT_FLUSH_INTERVAL_MS = 30_000

/** Length of the default query window: today plus the six days before it. */
export const DEFAULT_QUERY_DAYS = 7

/** Electricity price in 元 per kWh until the operator saves one. */
export const DEFAULT_PRICE_PER_KWH = 0.5

/** Lowest accepted electricity price in 元 per kWh. */
export const MIN_PRICE_PER_KWH = 0

/** Highest accepted electricity price in 元 per kWh. */
export const MAX_PRICE_PER_KWH = 100

const MS_PER_DAY = 86_400_000

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u

/**
 * Whether a value is an electricity price the ledger can persist.
 *
 * The contract wants a finite number in `[0, 100]` 元/度. `Number.isFinite`
 * already rejects numeric strings, which must not be silently coerced: the
 * panel sends JSON numbers, and a string would corrupt the arithmetic.
 *
 * @param {unknown} value - candidate price.
 * @returns {boolean} whether the value is a persistable 元/度 price.
 */
export function isPricePerKwh(value) {
  return Number.isFinite(value) && value >= MIN_PRICE_PER_KWH && value <= MAX_PRICE_PER_KWH
}

/**
 * Round to the contract's four decimals (watts x seconds leaves float noise).
 *
 * @param {number} value - raw value.
 * @returns {number} the value rounded to four decimals.
 */
function round4(value) {
  return Math.round(value * 10_000) / 10_000
}

/**
 * @param {unknown} error - thrown value.
 * @returns {string} a printable message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {number} value - number 0…99.
 * @returns {string} two digits.
 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * @param {number} year - full year.
 * @returns {boolean} whether the year is a Gregorian leap year.
 */
function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

/**
 * Days in one calendar month.
 *
 * @param {number} year - full Gregorian year.
 * @param {number} month - month 1…12.
 * @returns {number} 28…31.
 */
function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

/**
 * Split a `YYYY-MM-DD` string into numeric parts without assuming the date is
 * real (month/day ranges are only checked for "plausible" here).
 *
 * @param {unknown} dateKey - candidate date key.
 * @returns {{ year: number, month: number, day: number } | null} the parts, or null when the shape is wrong.
 */
function dateKeyParts(dateKey) {
  if (typeof dateKey !== 'string') return null
  const match = DATE_KEY_PATTERN.exec(dateKey)
  if (match === null) return null
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

/**
 * Epoch milliseconds of one calendar date's midnight (UTC).
 *
 * Calendar arithmetic on date keys is done in UTC so a DST transition can never
 * turn one local day into 23 or 25 hours; the "local" part of the ledger lives
 * only in `localDateKey`.
 *
 * @param {string} dateKey - real date key.
 * @returns {number} UTC midnight of that calendar date, or NaN for an invalid key.
 */
function dateKeyToUtcMs(dateKey) {
  const parts = dateKeyParts(dateKey)
  if (parts === null) return Number.NaN
  // `Date.UTC` maps years 0…99 to 1900…1999; `setUTCFullYear` keeps them exact.
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day)
  return date.getTime()
}

/**
 * Format a UTC-midnight epoch as a date key.
 *
 * @param {Date} date - a date whose UTC calendar fields are meaningful.
 * @returns {string} `YYYY-MM-DD`.
 */
function dateKeyFromUtcDate(date) {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

/**
 * The local calendar date of one instant, as the ledger's bucket key.
 *
 * @param {number} ms - epoch milliseconds.
 * @returns {string} local `YYYY-MM-DD`, or an empty string for a non-finite clock.
 */
export function localDateKey(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value)) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * The local date key of "now".
 *
 * @param {number} [nowMs] - epoch milliseconds; defaults to `Date.now()`.
 * @returns {string} local `YYYY-MM-DD`.
 */
export function todayDateKey(nowMs = Date.now()) {
  return localDateKey(nowMs)
}

/**
 * Whether a value is a real local date key: `YYYY-MM-DD` and an actual
 * Gregorian calendar date (`2026-02-30` is rejected).
 *
 * @param {unknown} value - candidate value.
 * @returns {boolean} whether it is a real date key.
 */
export function isDateKey(value) {
  const parts = dateKeyParts(value)
  if (parts === null) return false
  if (parts.year < 1 || parts.year > 9999) return false
  if (parts.month < 1 || parts.month > 12) return false
  if (parts.day < 1) return false
  return parts.day <= daysInMonth(parts.year, parts.month)
}

/**
 * Add calendar days to a date key, crossing month, year and leap-day
 * boundaries correctly (and immune to daylight-saving shifts).
 *
 * @param {string} dateKey - starting date key.
 * @param {number} n - whole days, negative to move backwards.
 * @returns {string} the shifted date key, or an empty string for an invalid input.
 */
export function addDays(dateKey, n) {
  const amount = Number(n)
  if (!Number.isInteger(amount)) return ''
  const base = isDateKey(dateKey) ? dateKeyToUtcMs(dateKey) : Number.NaN
  if (!Number.isFinite(base)) return ''
  const shifted = new Date(base + amount * MS_PER_DAY)
  return dateKeyFromUtcDate(shifted)
}

/**
 * Number of calendar days in an inclusive range (`from`…`to`).
 *
 * @param {string} from - first date key.
 * @param {string} to - last date key.
 * @returns {number} the inclusive day count; 0 when either key is invalid or `from` is after `to`.
 */
export function daySpan(from, to) {
  if (!isDateKey(from) || !isDateKey(to)) return 0
  const days = Math.round((dateKeyToUtcMs(to) - dateKeyToUtcMs(from)) / MS_PER_DAY) + 1
  return days > 0 ? days : 0
}

/**
 * Read one persisted ledger document.
 *
 * Any failure is reported through `warn` and yields an empty ledger (with the
 * default price): a corrupt ledger must never stop the monitor from sampling,
 * and the next flush overwrites the bad file with a valid one.
 *
 * @param {string} statePath - JSON file path.
 * @param {(message: string, error?: unknown) => void} warn - diagnostic sink.
 * @returns {{ days: Map<string, number>, pricePerKwh: number }} the buckets plus the persisted price, or the empty ledger.
 */
function readPersistedLedger(statePath, warn) {
  const days = new Map()
  let text
  try {
    text = readFileSync(statePath, 'utf8')
  } catch (error) {
    // A first run has no file yet; that is not worth a warning.
    if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') {
      warn(`could not read the energy ledger ${statePath}: ${messageOf(error)}`, error)
    }
    return { days, pricePerKwh: DEFAULT_PRICE_PER_KWH }
  }
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    warn(`could not parse the energy ledger ${statePath}: ${messageOf(error)}`, error)
    return { days, pricePerKwh: DEFAULT_PRICE_PER_KWH }
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    warn(`the energy ledger ${statePath} does not contain a JSON object`)
    return { days, pricePerKwh: DEFAULT_PRICE_PER_KWH }
  }
  if (document.version !== undefined && document.version !== ENERGY_LEDGER_VERSION) {
    warn(`the energy ledger ${statePath} has an unsupported version ${JSON.stringify(document.version)}`)
    return { days, pricePerKwh: DEFAULT_PRICE_PER_KWH }
  }
  const rawDays = document.days
  if (rawDays === null || typeof rawDays !== 'object' || Array.isArray(rawDays)) {
    warn(`the energy ledger ${statePath} has no days object`)
    return { days, pricePerKwh: DEFAULT_PRICE_PER_KWH }
  }
  let skipped = 0
  for (const [key, rawWh] of Object.entries(rawDays)) {
    const wh = Number(rawWh)
    if (!isDateKey(key) || !Number.isFinite(wh) || wh <= 0) {
      skipped += 1
      continue
    }
    days.set(key, round4(wh))
  }
  if (skipped > 0) warn(`ignored ${skipped} invalid day entries in the energy ledger ${statePath}`)
  // Old files predate the price field and the panel's price editor, so an
  // absent value is the documented default rather than corruption; a present
  // but unusable value is a warning, never an error that loses the buckets.
  let pricePerKwh = DEFAULT_PRICE_PER_KWH
  if (document.pricePerKwh !== undefined) {
    if (isPricePerKwh(document.pricePerKwh)) pricePerKwh = document.pricePerKwh
    else warn(`the energy ledger ${statePath} has an invalid pricePerKwh ${JSON.stringify(document.pricePerKwh)}; using ${DEFAULT_PRICE_PER_KWH} 元/度`)
  }
  return { days, pricePerKwh }
}

/**
 * Local-date → watt-hour buckets with throttled, atomic persistence.
 *
 * The monitor feeds one `record(wh, nowMs)` per sampling tick; the panel reads
 * the cheap `snapshot()` summary from the 1 s poll and the date-range totals
 * from `query()` on demand.
 */
export class EnergyLedger {
  /**
   * @param {object} options - ledger options.
   * @param {string} [options.statePath] - JSON file persisted to and loaded from; omit for an in-memory ledger.
   * @param {() => number} [options.now] - clock in epoch milliseconds, injectable for tests.
   * @param {(message: string, error?: unknown) => void} [options.warn] - diagnostic sink.
   * @param {number} [options.retentionDays] - days of history kept (oldest dropped first).
   * @param {number} [options.flushIntervalMs] - minimum delay between two throttled writes.
   */
  constructor({
    statePath = undefined,
    now = () => Date.now(),
    warn = () => {},
    retentionDays = DEFAULT_RETENTION_DAYS,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  } = {}) {
    this.statePath = typeof statePath === 'string' && statePath !== '' ? statePath : undefined
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.warn = typeof warn === 'function' ? warn : () => {}
    this.retentionDays = Number.isFinite(retentionDays) && retentionDays >= 1
      ? Math.floor(retentionDays)
      : DEFAULT_RETENTION_DAYS
    this.flushIntervalMs = Number.isFinite(flushIntervalMs) && flushIntervalMs >= 0
      ? flushIntervalMs
      : DEFAULT_FLUSH_INTERVAL_MS
    const persisted = this.statePath === undefined
      ? { days: new Map(), pricePerKwh: DEFAULT_PRICE_PER_KWH }
      : readPersistedLedger(this.statePath, this.warn)
    /** @type {Map<string, number>} local date → watt-hours, four decimals. */
    this.days = persisted.days
    /** Operator's electricity price in 元 per kWh; persisted beside the buckets. */
    this.pricePerKwh = persisted.pricePerKwh
    this.prune()
    /** Whether the in-memory buckets carry changes not yet written to disk. */
    this.dirty = false
    /** @type {number | null} clock of the last throttled flush attempt; null means "never flushed". */
    this.lastFlushAt = null
    /** @type {string | null} local date of the last recorded tick; drives rollover detection. */
    this.lastDateKey = null
    /** @type {string | null} ISO timestamp of the last successful write. */
    this.updatedAt = null
  }

  /**
   * Attribute one tick's watt-hours to the local date of `nowMs`.
   *
   * The day is derived from the monitor's injected clock (not `Date.now()`) so
   * tests can walk a midnight boundary deterministically. Values that are not
   * finite and non-negative are ignored: a stalled or unavailable IOReport
   * reading must not poison the ledger.
   *
   * @param {number} wh - watt-hours accumulated by this tick.
   * @param {number} [nowMs] - tick clock in epoch milliseconds; defaults to `this.now()`.
   * @returns {void}
   */
  record(wh, nowMs) {
    const value = Number(wh)
    if (!Number.isFinite(value) || value < 0) return
    const at = Number(nowMs)
    const key = localDateKey(Number.isFinite(at) ? at : Number(this.now()))
    if (key === '') return
    const rolled = this.lastDateKey !== null && this.lastDateKey !== key
    if (value > 0) {
      // Storing the rounded cumulative bucket keeps the file stable without
      // losing the contract's four decimals.
      const next = round4((this.days.get(key) ?? 0) + value)
      if (next > 0) {
        this.days.set(key, next)
        this.prune()
        this.dirty = true
      }
    }
    this.lastDateKey = key
    // A new local day is the one moment the panel must not lose: flush right
    // away instead of waiting out the throttle window.
    if (rolled) this.flush()
    else if (this.dirty) this.flushIfDue()
  }

  /**
   * @returns {{ todayWh: number, totalWh: number, days: number, since: string | null, pricePerKwh: number, costToday: number, costTotal: number }} the cheap summary carried by every monitor snapshot.
   */
  snapshot() {
    const keys = [...this.days.keys()].sort()
    let total = 0
    for (const key of keys) total += this.days.get(key) ?? 0
    const todayKey = localDateKey(Number(this.now()))
    const today = todayKey === '' ? 0 : (this.days.get(todayKey) ?? 0)
    const todayWh = round4(today)
    const totalWh = round4(total)
    const pricePerKwh = this.pricePerKwh
    return {
      todayWh,
      totalWh,
      days: keys.length,
      since: keys.length === 0 ? null : keys[0],
      pricePerKwh,
      costToday: round4((todayWh / 1000) * pricePerKwh),
      costTotal: round4((totalWh / 1000) * pricePerKwh),
    }
  }

  /**
   * Save the operator's electricity price.
   *
   * The price is a setting the operator just confirmed in the panel, so it is
   * written immediately instead of waiting out the flush throttle: a crash
   * right after 保存 must not silently revert the 电费 to the old rate.
   *
   * Invalid input returns `null` rather than throwing: this module is mounted in
   * the monitor's sampling loop and must never throw across it. The dispatcher
   * validates first and turns a bad panel value into an `invalid_request`.
   *
   * @param {unknown} pricePerKwh - 元 per kWh, finite and within `[0, 100]`.
   * @returns {{ todayWh: number, totalWh: number, days: number, since: string | null, pricePerKwh: number, costToday: number, costTotal: number } | null} the new summary, or null for an invalid price.
   */
  setPrice(pricePerKwh) {
    if (!isPricePerKwh(pricePerKwh)) return null
    this.pricePerKwh = pricePerKwh
    this.dirty = true
    this.flush()
    return this.snapshot()
  }

  /**
   * Daily totals for an inclusive local-date range.
   *
   * Every calendar day of the range is present, oldest first, with `wh: 0` on
   * days the ledger has no data for. Absent fields fall back to the panel's
   * default window: `to` is today and `from` is six days before it.
   *
   * @param {{ from?: string, to?: string }} [range] - inclusive local date keys; invalid or missing values fall back to the defaults.
   * @returns {{ from: string, to: string, days: { date: string, wh: number }[], totalWh: number, averageWh: number, pricePerKwh: number, totalCost: number, averageCost: number }} the range statistics.
   */
  query({ from, to } = {}) {
    const today = todayDateKey(Number(this.now()))
    const end = isDateKey(to) ? to : today
    const start = isDateKey(from) ? from : (end === '' ? '' : addDays(end, -(DEFAULT_QUERY_DAYS - 1)))
    const pricePerKwh = this.pricePerKwh
    const count = daySpan(start, end)
    if (count === 0) {
      return { from: start, to: end, days: [], totalWh: 0, averageWh: 0, pricePerKwh, totalCost: 0, averageCost: 0 }
    }
    /** @type {{ date: string, wh: number }[]} */
    const days = []
    let total = 0
    for (let index = 0; index < count; index += 1) {
      const date = addDays(start, index)
      const wh = round4(this.days.get(date) ?? 0)
      total += wh
      days.push({ date, wh })
    }
    const totalWh = round4(total)
    const averageWh = round4(total / count)
    return {
      from: start,
      to: end,
      days,
      totalWh,
      averageWh,
      pricePerKwh,
      totalCost: round4((totalWh / 1000) * pricePerKwh),
      averageCost: round4((averageWh / 1000) * pricePerKwh),
    }
  }

  /** Directly flush the ledger when it has pending changes (no-op otherwise). */
  flush() {
    if (this.statePath === undefined) {
      // No file to own; drop the dirty flag so callers stay cheap.
      this.dirty = false
      return
    }
    if (!this.dirty) return
    const nowMs = Number(this.now())
    // Throttle failed writes too: a read-only state directory must not warn on
    // every 1 s tick.
    if (Number.isFinite(nowMs)) this.lastFlushAt = nowMs
    try {
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
      /** @type {Record<string, number>} */
      const days = {}
      for (const key of [...this.days.keys()].sort()) days[key] = this.days.get(key)
      const updatedAt = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString()
      // Atomic replace: a crash mid-write leaves the previous valid document.
      const temporary = `${this.statePath}.tmp-${process.pid}`
      writeFileSync(temporary, `${JSON.stringify({ version: ENERGY_LEDGER_VERSION, days, pricePerKwh: this.pricePerKwh, updatedAt }, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, this.statePath)
      this.updatedAt = updatedAt
      this.dirty = false
    } catch (error) {
      this.warn(`could not save the energy ledger to ${this.statePath}: ${messageOf(error)}`, error)
    }
  }

  /** Flush pending changes; the monitor calls this when the plugin unloads. */
  dispose() {
    this.flush()
  }

  /** Drop the oldest date buckets beyond `retentionDays`. */
  prune() {
    if (this.days.size <= this.retentionDays) return
    const keys = [...this.days.keys()].sort()
    const excess = this.days.size - this.retentionDays
    for (let index = 0; index < excess; index += 1) this.days.delete(keys[index])
  }

  /** Flush when the throttle window has elapsed since the last write attempt. */
  flushIfDue() {
    const nowMs = Number(this.now())
    const due = this.lastFlushAt === null
      || !Number.isFinite(nowMs)
      || nowMs - this.lastFlushAt >= this.flushIntervalMs
    if (due) this.flush()
  }
}
