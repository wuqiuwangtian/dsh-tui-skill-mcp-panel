import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { SkillTextReader, readSkillPreview, PREVIEW_BYTES } from '../../lib/types/domain/skills/text-reader.js'
import { sanitizeText, wrapTextLines, cellWidth } from '../../lib/types/shared/format.js'
import { ManagerRuntime } from '../../lib/types/host/manager-runtime.js'

async function fixture(t, content = '') {
  const root = await fs.mkdtemp(join(tmpdir(), 'skill-text-')), path = join(root, 'skill.md')
  await fs.writeFile(path, content)
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { root, path }
}
async function reader(t, path, width, options) {
  const value = await SkillTextReader.create(path, width, options)
  t.after(() => value.close())
  return value
}
const oracle = (raw, width) => wrapTextLines(sanitizeText(raw).replace(/\r\n?/gu, '\n').split('\n'), width)

test('full reader preserves empty lines, CRLF, tab spacing, CJK and emoji without terminal controls', async t => {
  const raw = '---\r\nname: demo\r\n---\r\n中😀文\tA\x1b[31m\x9bB\rEND\n\n'
  const f = await fixture(t, raw), text = await reader(t, f.path, 6)
  const expected = oracle(raw, 6), page = await text.page(0, expected.length)
  assert.deepEqual(page.lines, expected)
  assert.equal(text.totalRows, expected.length)
  assert.ok(page.lines.every(line => cellWidth(line) <= 6))
  assert.ok(!page.lines.join('').includes('\x1b'))
  assert.equal(await fs.readFile(f.path, 'utf8'), raw)
})

test('empty files and trailing CRLF have exact first/last pages', async t => {
  const f = await fixture(t)
  const empty = await reader(t, f.path, 2)
  assert.deepEqual(await empty.page(0, 3), { offset: 0, totalRows: 1, lines: [''] })
  await fs.writeFile(f.path, 'x\r\n')
  const value = await reader(t, f.path, 2)
  assert.deepEqual((await value.page(0, 8)).lines, ['x', ''])
})

test('UTF-8 split at disk chunk and sparse row boundaries still pages exactly', async t => {
  const raw = 'a'.repeat(32767) + '中😀文\r\n' + '中😀\r\n'.repeat(530) + 'last-page-END'
  const f = await fixture(t, raw)
  for (const width of [2, 17, 96]) {
    const value = await reader(t, f.path, width), expected = oracle(raw, width)
    assert.equal(value.totalRows, expected.length)
    for (const offset of [0, 253, 255, 256, 257, 510, expected.length - 7, expected.length + 100]) {
      const page = await value.page(offset, 7), start = Math.max(0, Math.min(offset, expected.length - 7))
      assert.equal(page.offset, start)
      assert.deepEqual(page.lines, expected.slice(start, start + 7), `${width} cells at ${offset}`)
    }
  }
})

test('large single-line and >400-line files reach their tail with bounded page output and an event-loop yield', async t => {
  const raw = '中文😀x'.repeat(100000) + '\n' + 'normal-line\n'.repeat(12000) + 'FULL-TEXT-END'
  const f = await fixture(t, raw), controller = new AbortController()
  let heartbeat = false, responsiveDuringIndex = false, progress = 0
  const building = SkillTextReader.create(f.path, 30, { signal: controller.signal, progress: () => { progress++; if (progress === 1) setTimeout(() => { heartbeat = true }, 0); if (heartbeat) responsiveDuringIndex = true } })
  await setImmediate()
  const value = await building; t.after(() => value.close())
  assert.ok(responsiveDuringIndex && progress > 2)
  const page = await value.page(value.totalRows, 6)
  assert.equal(page.lines.length, 6)
  assert.ok(page.lines.join('').endsWith('FULL-TEXT-END'))
  assert.ok(page.lines.every(line => cellWidth(line) <= 30))
})

test('preview is bounded, preserves a split UTF-8 character safely and reports incompleteness', async t => {
  const f = await fixture(t, 'x'.repeat(PREVIEW_BYTES - 1) + '中END')
  const preview = await readSkillPreview(f.path)
  assert.equal(preview.content, 'x'.repeat(PREVIEW_BYTES - 1))
  assert.equal(preview.truncated, true)
  await fs.writeFile(f.path, 'small\n')
  assert.deepEqual(await readSkillPreview(f.path), { content: 'small\n', truncated: false })
})

test('in-place writes, path replacement and deletion invalidate existing snapshots', async t => {
  const f = await fixture(t, 'original')
  const first = await reader(t, f.path, 30)
  await fs.writeFile(f.path, 'changed-size')
  await assert.rejects(first.page(0, 3), /已变化/u)
  const second = await reader(t, f.path, 30)
  await fs.rename(f.path, join(f.root, 'old'))
  await fs.writeFile(f.path, 'changed-size')
  await assert.rejects(second.page(0, 3), /已变化/u)
  const third = await reader(t, f.path, 30)
  await fs.rm(f.path)
  await assert.rejects(third.page(0, 3), /ENOENT|已变化/u)
})

test('abort during indexing and close during paging do not leave a usable stale reader', async t => {
  const f = await fixture(t, 'line\n'.repeat(100000)), controller = new AbortController()
  await assert.rejects(SkillTextReader.create(f.path, 10, { signal: controller.signal, progress: () => controller.abort() }), /abort/iu)
  const value = await reader(t, f.path, 10)
  await value.close(); await value.close()
  await assert.rejects(value.page(0, 1), /已关闭/u)
})

test('regular-file symlinks are readable; directories, invalid UTF-8 and non-finite coordinates fail explicitly', async t => {
  const f = await fixture(t, 'linked-text'), link = join(f.root, 'linked.md')
  await fs.symlink(f.path, link)
  const value = await reader(t, link, 30)
  assert.deepEqual((await value.page(0, 1)).lines, ['linked-text'])
  await assert.rejects(SkillTextReader.create(f.root, 30), /普通文件/u)
  await assert.rejects(readSkillPreview(f.root), /普通文件/u)
  await assert.rejects(SkillTextReader.create(f.path, NaN), /有限/u)
  await assert.rejects(value.page(Infinity, 1), /有限/u)
  await fs.writeFile(f.path, Buffer.from([0xff, 0xfe]))
  await assert.rejects(SkillTextReader.create(f.path, 30), /encoded data|encoding/iu)
})

async function runtimeFixture(t) {
  const f = await fixture(t, '---\nname: fixture\ndescription: fixture\n---\n' + 'initial-body\n'.repeat(1600) + 'TAIL-END')
  const keys = ['DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_BUNDLED_SKILL_DIR', 'SKILL_MCP_PANEL_HOME']
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  for (const key of keys) process.env[key] = join(f.root, key)
  const runtime = new ManagerRuntime({ get: () => undefined })
  t.after(() => { runtime.dispose(); for (const [key,value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  await runtime.ensureFresh()
  return { ...f, runtime, instance: { id: 'fixture', skillFile: f.path } }
}

test('runtime refresh discards old preview cache and full reader detects writes until explicit reread', async t => {
  const f = await runtimeFixture(t), runtime = f.runtime
  await runtime.loadDetail(f.instance)
  assert.equal(runtime.snapshot().detail.truncated, true)
  assert.ok(runtime.snapshot().detail.content.length <= PREVIEW_BYTES)
  await runtime.openSkillText(f.instance, 20, 6)
  assert.equal(runtime.snapshot().fullText.status, 'ready')
  await runtime.readSkillTextPage(runtime.snapshot().fullText.totalRows, 6)
  assert.ok(runtime.snapshot().fullText.lines.join('').includes('TAIL-END'))
  await fs.writeFile(f.path, 'new-content-END')
  await runtime.readSkillTextPage(0, 6)
  assert.equal(runtime.snapshot().fullText.status, 'error')
  assert.match(runtime.snapshot().fullText.error, /已变化/u)
  await runtime.openSkillText(f.instance, 20, 6)
  assert.deepEqual(runtime.snapshot().fullText.lines, ['new-content-END'])
  await runtime.refresh('test-new-content'); await runtime.loadDetail(f.instance)
  assert.equal(runtime.snapshot().detail.content, 'new-content-END')
})

test('runtime canceled and superseded full reads cannot publish late file results', async t => {
  const f = await runtimeFixture(t), other = join(f.root, 'other.md')
  await fs.writeFile(f.path, 'large\n'.repeat(500000))
  await fs.writeFile(other, 'OTHER-END')
  const pending = f.runtime.openSkillText(f.instance, 10, 4)
  await setImmediate()
  const next = f.runtime.openSkillText({ id: 'other', skillFile: other }, 10, 4)
  await Promise.all([pending,next])
  assert.equal(f.runtime.snapshot().fullText.id, 'other')
  assert.deepEqual(f.runtime.snapshot().fullText.lines, ['OTHER-END'])
  const canceled = f.runtime.openSkillText(f.instance, 10, 4)
  f.runtime.closeSkillText(); await canceled
  assert.equal(f.runtime.snapshot().fullText, undefined)
  const unloading = f.runtime.openSkillText(f.instance, 10, 4)
  f.runtime.dispose(); await unloading
  assert.equal(f.runtime.snapshot().fullText, undefined)
})
