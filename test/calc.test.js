/**
 * Calculator engine tests: grammar, formatting, angle units, and the refusal
 * codes the panel and the tool localize.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { evaluate, formatNumber, normalizeExpression, tokenize, FUNCTION_NAMES, MAX_EXPRESSION_LENGTH } from '../src/calc.js'

test('evaluates arithmetic with the expected precedence', () => {
  assert.equal(evaluate('1+2*3').value, 7)
  assert.equal(evaluate('(1+2)*3').value, 9)
  assert.equal(evaluate('10/4').value, 2.5)
  assert.equal(evaluate('2^10').value, 1024)
  assert.equal(evaluate('2^3^2').value, 512, 'exponentiation is right-associative')
  assert.equal(evaluate('-2^2').value, -4, 'unary minus binds below exponentiation')
  assert.equal(evaluate('+5 - -3').value, 8)
})

test('supports implicit multiplication and named constants', () => {
  assert.equal(evaluate('2(3+4)').value, 14)
  assert.equal(evaluate('(1+1)(2+2)').value, 8)
  assert.ok(Math.abs(evaluate('2pi').value - Math.PI * 2) < 1e-12)
  assert.ok(Math.abs(evaluate('e^2').value - Math.E ** 2) < 1e-12)
  assert.equal(evaluate('g').value, 9.80665)
})

test('supports postfix percent and modulo', () => {
  assert.equal(evaluate('50%').value, 0.5)
  assert.equal(evaluate('50%+1').value, 1.5)
  assert.equal(evaluate('200*10%').value, 20)
  assert.equal(evaluate('10 % 3').value, 1)
  assert.equal(evaluate('10%3').value, 1)
})

test('supports the documented functions', () => {
  assert.equal(evaluate('sqrt(2)').formatted, formatNumber(Math.sqrt(2)))
  assert.equal(evaluate('hypot(3,4)').value, 5)
  assert.equal(evaluate('min(3,1,2)').value, 1)
  assert.equal(evaluate('max(3,1,2)').value, 3)
  assert.equal(evaluate('log(100)').value, 2)
  assert.equal(evaluate('ln(e)').value, 1)
  assert.equal(evaluate('abs(-7)').value, 7)
  assert.equal(evaluate('round(2.6)').value, 3)
  assert.equal(evaluate('pow(2, 5)').value, 32)
  assert.equal(evaluate('mod(10, 4)').value, 2)
  assert.ok(FUNCTION_NAMES.includes('atan2'))
  for (const name of FUNCTION_NAMES) assert.ok(name.length > 0)
})

test('trig angles default to degrees and accept radians', () => {
  assert.equal(evaluate('sin(30)').formatted, '0.5')
  assert.equal(evaluate('cos(60)').formatted, '0.5')
  assert.ok(Math.abs(evaluate('sin(pi/2)', { angles: 'rad' }).value - 1) < 1e-12)
  assert.equal(evaluate('asin(0.5)').formatted, '30')
  assert.ok(Math.abs(evaluate('asin(0.5)', { angles: 'rad' }).value - Math.PI / 6) < 1e-12)
})

test('normalizes calculator glyphs and unicode operators', () => {
  assert.equal(evaluate('3×4').value, 12)
  assert.equal(evaluate('10÷2').value, 5)
  assert.equal(evaluate('5−2').value, 3)
  assert.equal(evaluate('π*2').formatted, formatNumber(Math.PI * 2))
  assert.equal(evaluate('√9').value, 3)
  assert.equal(evaluate('（1+2）×3').value, 9)
  assert.equal(normalizeExpression('  1 + 2  '), '1 + 2')
})

test('formats results the way a calculator display does', () => {
  assert.equal(formatNumber(7), '7')
  assert.equal(formatNumber(0.1 + 0.2), '0.3')
  assert.equal(formatNumber(1 / 3), '0.333333333333')
  assert.equal(formatNumber(1e20), '1e20')
  assert.equal(formatNumber(1e-9), '1e-9')
  assert.equal(formatNumber(-0), '0')
  assert.equal(evaluate('1/3').formatted, '0.333333333333')
})

test('refuses invalid input with stable codes', () => {
  const cases = [
    ['', 'invalid_expression'],
    ['   ', 'invalid_expression'],
    ['1+', 'invalid_expression'],
    ['(1+2', 'invalid_expression'],
    ['1+2)', 'invalid_expression'],
    ['1/0', 'divide_by_zero'],
    ['sqrt(-1)', 'domain_error'],
    ['ln(0)', 'domain_error'],
    ['foo(2)', 'unknown_function'],
    ['abc', 'unknown_identifier'],
    ['1 $ 2', 'invalid_expression'],
    ['sqrt(1,2)', 'invalid_expression'],
    ['min()', 'invalid_expression'],
  ]
  for (const [expression, code] of cases) {
    assert.throws(() => evaluate(expression), (error) => {
      assert.equal(error.code, code, `${JSON.stringify(expression)} must fail with ${code}`)
      return true
    })
  }
})

test('bounds the expression size', () => {
  assert.throws(() => evaluate('1'.repeat(MAX_EXPRESSION_LENGTH + 1)), (error) => error.code === 'too_long')
  assert.equal(tokenize('1+2').length, 3)
})
