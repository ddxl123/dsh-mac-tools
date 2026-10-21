/**
 * The calculator engine behind the panel's calculator tab. Pure, side-effect
 * free and unit-tested without a browser.
 *
 * The evaluator is a small recursive-descent parser over a deliberate
 * arithmetic grammar — no `eval`, no `Function`, no dependency. It supports
 * decimal/scientific literals, `+ - * / % ^`, parentheses, unary signs,
 * implicit multiplication (`2(3+4)`, `2pi`), postfix percent (`50%` → 0.5),
 * constants (`pi`, `e`, `tau`) and the functions listed in {@link FUNCTIONS}.
 *
 * Angles are degrees by default (what a desktop calculator's sin/cos/tan keys
 * show); pass `angles: 'rad'` for radians. Inverse trig returns an angle in the
 * selected unit.
 *
 * @module dsh-mac-tools/calc
 */

/** Longest expression accepted, in characters. */
export const MAX_EXPRESSION_LENGTH = 400
/** Most tokens one expression may produce. */
export const MAX_TOKENS = 400

/** A refusal from the calculator, carrying a stable code for the caller. */
export class CalcError extends Error {
  /**
   * @param {string} message - operator-facing description.
   * @param {string} code - stable failure code.
   * @param {object} [details] - extra structured context.
   */
  constructor(message, code = 'invalid_expression', details = {}) {
    super(message)
    this.name = 'CalcError'
    this.code = code
    this.details = details
  }
}

/** Named constants. `π` is normalized to `pi` before tokenizing. */
const CONSTANTS = Object.freeze({
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
  /** Standard gravity, occasionally handy and harmless to expose. */
  g: 9.80665,
})

/** Trig functions whose argument is an angle in the selected unit. */
const ANGLE_FUNCTIONS = new Set(['sin', 'cos', 'tan'])
/** Inverse trig functions whose result is an angle in the selected unit. */
const INVERSE_ANGLE_FUNCTIONS = new Set(['asin', 'acos', 'atan'])

function domainError(message) {
  return new CalcError(message, 'domain_error')
}

/** @param {number} value - candidate result. */
function finite(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) throw domainError('the operation has no real result')
  if (!Number.isFinite(value)) throw domainError('the result is not a finite number')
  return value
}

/**
 * Function table. Each entry declares its arity (`null` = variadic) and the
 * numeric implementation; `angle` marks the functions that consume or return
 * an angle in the selected unit.
 */
const FUNCTIONS = Object.freeze({
  sqrt: { arity: 1, fn: (x) => (x < 0 ? domainError('sqrt of a negative number has no real result') : Math.sqrt(x)) },
  cbrt: { arity: 1, fn: Math.cbrt },
  abs: { arity: 1, fn: Math.abs },
  round: { arity: 1, fn: Math.round },
  floor: { arity: 1, fn: Math.floor },
  ceil: { arity: 1, fn: Math.ceil },
  trunc: { arity: 1, fn: Math.trunc },
  sign: { arity: 1, fn: Math.sign },
  exp: { arity: 1, fn: Math.exp },
  ln: { arity: 1, fn: (x) => (x <= 0 ? domainError('ln needs a positive number') : Math.log(x)) },
  log: { arity: 1, fn: (x) => (x <= 0 ? domainError('log needs a positive number') : Math.log10(x)) },
  log2: { arity: 1, fn: (x) => (x <= 0 ? domainError('log2 needs a positive number') : Math.log2(x)) },
  sin: { arity: 1, angle: 'in', fn: Math.sin },
  cos: { arity: 1, angle: 'in', fn: Math.cos },
  tan: { arity: 1, angle: 'in', fn: Math.tan },
  asin: { arity: 1, angle: 'out', fn: (x) => (x < -1 || x > 1 ? domainError('asin needs a number between -1 and 1') : Math.asin(x)) },
  acos: { arity: 1, angle: 'out', fn: (x) => (x < -1 || x > 1 ? domainError('acos needs a number between -1 and 1') : Math.acos(x)) },
  atan: { arity: 1, angle: 'out', fn: Math.atan },
  pow: { arity: 2, fn: (a, b) => Math.pow(a, b) },
  atan2: { arity: 2, fn: Math.atan2 },
  hypot: { arity: null, fn: (...values) => Math.hypot(...values) },
  min: { arity: null, fn: (...values) => Math.min(...values) },
  max: { arity: null, fn: (...values) => Math.max(...values) },
  mod: { arity: 2, fn: (a, b) => (b === 0 ? domainError('mod by zero') : a % b) },
})

/** Every function name, for error messages and tests. */
export const FUNCTION_NAMES = Object.freeze(Object.keys(FUNCTIONS).sort())

/** A parsed token. @typedef {{ type: 'number' | 'name' | 'op', value: string | number, at: number }} Token */

/**
 * Normalize the input a person may type: translate full-width punctuation,
 * the sign glyphs a calculator keypad shows, `π` and `√` into parser input.
 *
 * @param {string} input - raw expression text.
 * @returns {string} normalized expression.
 */
export function normalizeExpression(input) {
  return String(input)
    .replace(/[×]/g, '*')
    .replace(/[÷]/g, '/')
    .replace(/[−–—]/g, '-')
    .replace(/[，]/g, ',')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[πΠ]/g, 'pi')
    .replace(/[％]/g, '%')
    .trim()
}

/**
 * Tokenize a normalized expression.
 *
 * @param {string} expression - normalized expression.
 * @returns {Token[]} tokens in reading order.
 * @throws {CalcError} on an illegal character, a malformed number, or excess length.
 */
export function tokenize(expression) {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new CalcError(`the expression is longer than ${MAX_EXPRESSION_LENGTH} characters`, 'too_long', { limit: MAX_EXPRESSION_LENGTH })
  }
  /** @type {Token[]} */
  const tokens = []
  let index = 0
  while (index < expression.length) {
    const rest = expression.slice(index)
    const whitespace = /^\s+/.exec(rest)
    if (whitespace !== null) {
      index += whitespace[0].length
      continue
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest)
    if (number !== null) {
      tokens.push({ type: 'number', value: Number(number[0]), at: index })
      index += number[0].length
      continue
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
    if (name !== null) {
      tokens.push({ type: 'name', value: name[0], at: index })
      index += name[0].length
      continue
    }
    const op = rest[0]
    if ('+-*/%^(),√'.includes(op)) {
      tokens.push({ type: 'op', value: op, at: index })
      index += 1
      continue
    }
    throw new CalcError(`unexpected character ${JSON.stringify(op)} at position ${index + 1}`, 'invalid_expression', { at: index })
  }
  if (tokens.length > MAX_TOKENS) throw new CalcError(`the expression has more than ${MAX_TOKENS} parts`, 'too_long', { limit: MAX_TOKENS })
  return tokens
}

/** Whether a token can begin an operand (used for implicit multiplication and percent). */
function startsOperand(token) {
  if (token === undefined) return false
  if (token.type === 'number' || token.type === 'name') return true
  return token.type === 'op' && token.value === '('
}

class Parser {
  /**
   * @param {Token[]} tokens - token stream.
   * @param {'deg' | 'rad'} angles - angle unit for trig functions.
   */
  constructor(tokens, angles) {
    this.tokens = tokens
    this.index = 0
    this.angles = angles
  }

  /** @returns {Token | undefined} the current token without consuming it. */
  peek(offset = 0) {
    return this.tokens[this.index + offset]
  }

  /** @param {string} value - operator/number literal to consume. */
  eatOp(value) {
    const token = this.peek()
    if (token !== undefined && token.type === 'op' && token.value === value) {
      this.index += 1
      return true
    }
    return false
  }

  /** @returns {Token} the current token. */
  requireToken() {
    const token = this.peek()
    if (token === undefined) throw new CalcError('the expression ends unexpectedly', 'invalid_expression')
    return token
  }

  /**
   * expression := term (('+' | '-') term)*
   * @returns {number} value.
   */
  parseExpression() {
    let value = this.parseTerm()
    for (;;) {
      if (this.eatOp('+')) value += this.parseTerm()
      else if (this.eatOp('-')) value -= this.parseTerm()
      else return value
    }
  }

  /**
   * term := unary (('*' | '/' | modulo | implicit-multiply) unary)*
   * @returns {number} value.
   */
  parseTerm() {
    let value = this.parseUnary()
    for (;;) {
      if (this.eatOp('*')) {
        value *= this.parseUnary()
        continue
      }
      if (this.eatOp('/')) {
        const divisor = this.parseUnary()
        if (divisor === 0) throw new CalcError('division by zero', 'divide_by_zero')
        value /= divisor
        continue
      }
      const token = this.peek()
      if (token !== undefined && token.type === 'op' && token.value === '%' && startsOperand(this.peek(1))) {
        this.index += 1
        const divisor = this.parseUnary()
        if (divisor === 0) throw new CalcError('mod by zero', 'divide_by_zero')
        value %= divisor
        continue
      }
      if (startsOperand(token)) {
        value *= this.parseUnary()
        continue
      }
      return value
    }
  }

  /**
   * unary := ('+' | '-' | '√') unary | power
   * @returns {number} value.
   */
  parseUnary() {
    if (this.eatOp('+')) return this.parseUnary()
    if (this.eatOp('-')) return -this.parseUnary()
    if (this.eatOp('√')) {
      const radicand = this.parseUnary()
      if (radicand < 0) throw domainError('the square root of a negative number has no real result')
      return finite(Math.sqrt(radicand))
    }
    return this.parsePower()
  }

  /**
   * power := postfix ('^' unary)?   (right-associative)
   * @returns {number} value.
   */
  parsePower() {
    const base = this.parsePostfix()
    if (this.eatOp('^')) return finite(Math.pow(base, this.parseUnary()))
    return base
  }

  /**
   * postfix := primary ('%' when not followed by an operand)*
   * @returns {number} value.
   */
  parsePostfix() {
    let value = this.parsePrimary()
    for (;;) {
      const token = this.peek()
      if (token === undefined || token.type !== 'op' || token.value !== '%') return value
      if (startsOperand(this.peek(1))) return value // modulo; the term loop owns it
      this.index += 1
      value /= 100
    }
  }

  /**
   * primary := number | name | name '(' arguments ')' | '(' expression ')'
   * @returns {number} value.
   */
  parsePrimary() {
    const token = this.requireToken()
    if (token.type === 'number') {
      this.index += 1
      return finite(/** @type {number} */ (token.value))
    }
    if (token.type === 'op' && token.value === '(') {
      this.index += 1
      const value = this.parseExpression()
      if (!this.eatOp(')')) throw new CalcError('a closing parenthesis is missing', 'invalid_expression')
      return value
    }
    if (token.type === 'name') {
      this.index += 1
      const name = /** @type {string} */ (token.value).toLowerCase()
      if (this.peek() !== undefined && this.peek().type === 'op' && this.peek().value === '(') {
        return this.parseCall(name)
      }
      if (Object.hasOwn(CONSTANTS, name)) return CONSTANTS[name]
      if (Object.hasOwn(FUNCTIONS, name)) throw new CalcError(`the function ${name}() needs parentheses`, 'invalid_expression')
      throw new CalcError(`unknown identifier ${JSON.stringify(/** @type {string} */ (token.value))}`, 'unknown_identifier', { name: token.value })
    }
    throw new CalcError(`unexpected ${JSON.stringify(token.value)} at position ${token.at + 1}`, 'invalid_expression', { at: token.at })
  }

  /**
   * Parse `name(arg, ...)` after the name has been consumed.
   * @param {string} name - lowercased function name.
   * @returns {number} value.
   */
  parseCall(name) {
    const definition = FUNCTIONS[name]
    if (definition === undefined) {
      throw new CalcError(`unknown function ${JSON.stringify(name)}`, 'unknown_function', { name: FUNCTIONS[name] === undefined ? name : undefined })
    }
    this.index += 1 // '('
    /** @type {number[]} */
    const args = []
    if (!this.eatOp(')')) {
      for (;;) {
        args.push(this.parseExpression())
        if (this.eatOp(',')) continue
        if (this.eatOp(')')) break
        throw new CalcError(`the argument list of ${name}() is not closed`, 'invalid_expression')
      }
    }
    if (definition.arity !== null && args.length !== definition.arity) {
      throw new CalcError(`${name}() takes ${definition.arity} argument${definition.arity === 1 ? '' : 's'}, got ${args.length}`, 'invalid_expression', {
        name,
        expected: definition.arity,
        received: args.length,
      })
    }
    if (definition.arity === null && args.length === 0) {
      throw new CalcError(`${name}() needs at least one argument`, 'invalid_expression', { name })
    }
    let values = args
    if (this.angles === 'deg') {
      if (ANGLE_FUNCTIONS.has(name)) values = args.map((value) => (value * Math.PI) / 180)
    }
    const result = finite(definition.fn(...values))
    if (this.angles === 'deg' && INVERSE_ANGLE_FUNCTIONS.has(name)) return finite((result * 180) / Math.PI)
    return result
  }
}

/**
 * Format a finite number the way a calculator display would: integers without
 * a decimal point, ordinary decimals at up to 12 significant digits, and
 * scientific notation outside `1e-6 … 1e15`.
 *
 * @param {number} value - finite number.
 * @returns {string} display text.
 */
export function formatNumber(value) {
  if (!Number.isFinite(value)) throw domainError('the result is not a finite number')
  const normalized = Object.is(value, -0) ? 0 : value
  if (Number.isInteger(normalized) && Math.abs(normalized) < 1e15) return String(normalized)
  const absolute = Math.abs(normalized)
  if (absolute !== 0 && (absolute >= 1e15 || absolute < 1e-6)) {
    return normalized
      .toExponential(10)
      .replace(/\.?0+e/u, 'e')
      .replace(/e\+/u, 'e')
  }
  return String(Number(normalized.toPrecision(12)))
}

/**
 * Evaluate one expression.
 *
 * @param {string} input - expression as typed by a person or the model.
 * @param {object} [options] - evaluation options.
 * @param {'deg' | 'rad'} [options.angles] - angle unit; defaults to degrees.
 * @returns {{ expression: string, value: number, formatted: string, angles: 'deg' | 'rad' }} the result.
 * @throws {CalcError} when the expression is empty, malformed, or not a finite real number.
 */
export function evaluate(input, options = {}) {
  const angles = options.angles === 'rad' ? 'rad' : 'deg'
  const normalized = normalizeExpression(input ?? '')
  if (normalized === '') throw new CalcError('the expression is empty', 'invalid_expression')
  const tokens = tokenize(normalized)
  const parser = new Parser(tokens, angles)
  const value = parser.parseExpression()
  if (parser.index !== tokens.length) {
    const token = tokens[parser.index]
    throw new CalcError(`unexpected ${JSON.stringify(token.value)} at position ${token.at + 1}`, 'invalid_expression', { at: token.at })
  }
  const result = finite(value)
  return { expression: normalized, value: result, formatted: formatNumber(result), angles }
}
