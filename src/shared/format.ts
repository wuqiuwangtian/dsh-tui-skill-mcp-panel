/** Terminal-cell text helpers (CJK/emoji = 2 cells), shared by the UI and tests. */
import { eastAsianWidth } from 'get-east-asian-width'

/** Strip C0/C1 control characters except newline/tab, mirroring "untrusted text" rules. */
export function sanitizeText(input: string): string {
  return input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '')
}

/** Width of one code point in terminal cells. */
export function charWidth(char: string): number {
  const codePoint = char.codePointAt(0)
  if (codePoint === undefined) return 0
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0
  return eastAsianWidth(codePoint, { ambiguousAsWide: false })
}

/** Width of a string in terminal cells. */
export function cellWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

/** Truncate to at most `maxCells` cells, appending an ellipsis when cut. */
export function truncateToWidth(text: string, maxCells: number, ellipsis = '…'): string {
  if (maxCells <= 0) return ''
  const sanitized = sanitizeText(text)
  if (cellWidth(sanitized) <= maxCells) return sanitized
  const budget = Math.max(0, maxCells - cellWidth(ellipsis))
  let out = ''
  let width = 0
  for (const char of sanitized) {
    const next = charWidth(char)
    if (width + next > budget) break
    out += char
    width += next
  }
  return `${out}${ellipsis}`
}

/** Collapse to a single sanitized line and truncate by cells. */
export function oneLine(text: string, maxCells: number): string {
  return truncateToWidth(sanitizeText(text).replace(/\s+/gu, ' ').trim(), maxCells)
}

/** Show the cursor end of an append-only input without splitting a code point. */
export function inputTail(text: string, maxCells: number): string {
  const clean = sanitizeText(text).replace(/\s+/gu, ' ')
  if (cellWidth(clean) <= maxCells) return clean
  let out = ''
  let width = 0
  for (const char of Array.from(clean).reverse()) {
    if (width + charWidth(char) > Math.max(0, maxCells - 1)) break
    out = char + out
    width += charWidth(char)
  }
  return maxCells > 0 ? `…${out}` : ''
}

/** Hard-wrap plain text by terminal cells; one returned string is one screen row. */
export function wrapTextLines(lines: string[], width: number): string[] {
  const limit = Math.max(2, width)
  return lines.flatMap((line) => {
    const result: string[] = []
    let row = ''
    let cells = 0
    for (const char of sanitizeText(line).replace(/[\r\n\t]/gu, ' ')) {
      const size = charWidth(char)
      if (cells + size > limit) { result.push(row); row = ''; cells = 0 }
      row += char
      cells += size
    }
    result.push(row)
    return result
  })
}

/** Pad with spaces to exactly `width` cells (truncating first when needed). */
export function padToWidth(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, '')
  const padding = Math.max(0, width - cellWidth(truncated))
  return `${truncated}${' '.repeat(padding)}`
}

/** Take the first `lines` lines of a text block, sanitized for rendering. */
export function firstLines(text: string, lines: number): string[] {
  const sanitized = sanitizeText(text).replace(/\r\n?/gu, '\n')
  return sanitized.split('\n').slice(0, lines)
}
