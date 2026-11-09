import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellWidth, inputTail, wrapTextLines } from '../../lib/types/shared/format.js'

test('long append-only input shows its cursor end within the terminal-cell budget', () => {
  const text = `${'中文🧭'.repeat(30)}TAIL-END`
  const shown = inputTail(text, 14)
  assert.ok(shown.startsWith('…'))
  assert.ok(shown.endsWith('TAIL-END'))
  assert.ok(cellWidth(shown) <= 14)
  assert.equal(inputTail('short', 8), 'short')
  assert.equal(inputTail(text, 0), '')
  assert.equal(inputTail('a\n\tb', 10), 'a b')
})

test('plain-text pages wrap CJK and emoji by cells and remove control line breaks', () => {
  const lines = wrapTextLines(['中文🧭abc', 'line\nnext', '', '\x1btest'], 5)
  assert.ok(lines.every((line) => cellWidth(line) <= 5 && !/[\n\r\t\x1b]/u.test(line)))
  assert.equal(lines.join(''), '中文🧭abcline nexttest')
  assert.ok(lines.some((line) => line.includes('🧭')))
  assert.deepEqual(wrapTextLines([], 10), [])
})
