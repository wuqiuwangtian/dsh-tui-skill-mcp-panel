import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectVersions, exactVersion } from '../../lib/types/host/versions.js'

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'panel-versions-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const cli = join(root, 'cli'), entry = join(cli, 'lib/bin.js'), plugin = join(root, 'panel.json')
  const library = join(cli, 'node_modules/@deepseek-ai/dsh-app-boot')
  await fs.mkdir(join(cli, 'lib'), { recursive: true }); await fs.mkdir(join(library, 'lib'), { recursive: true })
  await fs.writeFile(entry, 'throw new Error("CLI-MUST-NOT-EXECUTE")')
  await fs.writeFile(join(cli, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '8.9.0', bin: { dsh: './lib/bin.js' } }))
  await fs.writeFile(join(library, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version: '1.2.3-rc.4+build.5', main: 'lib/index.js' }))
  await fs.writeFile(join(library, 'lib/index.js'), 'throw new Error("LIBRARY-MUST-NOT-EXECUTE")')
  await fs.writeFile(plugin, JSON.stringify({ name: 'dsh-tui-skill-mcp-panel', version: '0.1.0-dev.0' }))
  return { root, cli, entry, library, plugin, options: { processEntry: entry, pluginManifest: plugin, nodeVersion: '26.3.0' } }
}

test('versions accept exact semantic versions and reject ranges, placeholders and controls', () => {
  for (const good of ['0.1.0-dev.0', '0.19.0', '1.2.3-rc.4+build.5', '26.3.0']) assert.equal(exactVersion(good), true)
  for (const bad of ['>=0.19.0 <0.20.0', '^0.19.0', '*', 'latest', 'unknown', 'unavailable', 'v1.2.3', '1.2.3-01', '01.2.3', '1.2.3\x1b', '', null, 42]) assert.equal(exactVersion(bad), false)
})

test('package identity and live descriptor override unrelated installed/dev/CLI version numbers without executing code', async t => {
  const f = await fixture(t)
  const versions = await collectVersions({ ...f.options, host: { hostDescriptor: () => ({ hostId: 'dsh-tui', hostVersion: '0.19.7' }) } })
  assert.equal(versions.plugin.value, '0.1.0-dev.0')
  assert.equal(versions.host.value, '0.19.7')
  assert.equal(versions.kernel.value, '1.2.3-rc.4+build.5', 'app-boot version, not unrelated CLI package version')
  assert.equal(versions.node.value, '26.3.0')
  assert.equal(versions.kernel.source, join(f.library, 'package.json'))
  assert.equal(versions.host.source, 'tuiPluginHost.hostDescriptor().hostVersion')
})

test('missing, denied, malformed and async host descriptors remain unavailable without leaking provider errors', async t => {
  const f = await fixture(t)
  for (const host of [undefined, { hostDescriptor: () => { throw new Error('DO-NOT-LEAK') } },
    { hostDescriptor: () => ({ hostId: 'other', hostVersion: '0.19.0' }) },
    { hostDescriptor: () => ({ hostId: 'dsh-tui', hostVersion: '>=0.19.0' }) },
    { hostDescriptor: () => ({ hostId: 'dsh-tui', hostVersion: '0.0.0' }) },
    { hostDescriptor: () => null }, { hostDescriptor: () => Promise.reject(new Error('DO-NOT-LEAK')) }]) {
    const result = await collectVersions({ ...f.options, host })
    assert.equal(result.host.value, undefined)
    assert.ok(result.host.reason)
    assert.ok(!JSON.stringify(result).includes('DO-NOT-LEAK'))
  }
})

test('plugin corruption, wrong identity, directory and oversized manifest degrade independently', async t => {
  const f = await fixture(t)
  for (const raw of ['{"secret":"DO-NOT-LEAK"', '{"name":"other","version":"1.2.3"}', '{"name":"dsh-tui-skill-mcp-panel","version":"^1.2.3"}', ' '.repeat(65537)]) {
    await fs.writeFile(f.plugin, raw)
    const result = await collectVersions(f.options)
    assert.equal(result.plugin.value, undefined)
    assert.equal(result.node.value, '26.3.0')
    assert.ok(!JSON.stringify(result).includes('DO-NOT-LEAK'))
    assert.equal(await fs.readFile(f.plugin, 'utf8'), raw, 'read-only collector preserves raw data')
  }
  await fs.rm(f.plugin); await fs.mkdir(f.plugin)
  assert.equal((await collectVersions(f.options)).plugin.value, undefined)
})

test('no CLI, wrong bin, wrong enclosing package and relative entry never fall back to nearby installed versions', async t => {
  const f = await fixture(t)
  for (const entry of [join(f.root, 'missing'), 'lib/bin.js', process.execPath]) {
    assert.equal((await collectVersions({ ...f.options, processEntry: entry })).kernel.value, undefined)
  }
  await fs.writeFile(join(f.cli, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: './other.js' } }))
  assert.equal((await collectVersions(f.options)).kernel.value, undefined)
  await fs.writeFile(join(f.cli, 'lib/package.json'), '{"name":"unrelated","version":"1.2.3"}')
  assert.equal((await collectVersions(f.options)).kernel.value, undefined)
})

test('entry symlinks use the actual CLI package and metadata can refresh after a package change', async t => {
  const f = await fixture(t), link = join(f.root, 'dsh-link')
  await fs.symlink(f.entry, link)
  assert.equal((await collectVersions({ ...f.options, processEntry: link })).kernel.value, '1.2.3-rc.4+build.5')
  await fs.writeFile(join(f.library, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version: '2.0.0' }))
  assert.equal((await collectVersions(f.options)).kernel.value, '2.0.0')
  await fs.writeFile(join(f.library, 'package.json'), JSON.stringify({ name: 'unrelated', version: '2.0.0' }))
  assert.equal((await collectVersions(f.options)).kernel.value, undefined)
})

test('normal headless execution reports own package and Node but leaves absent host/CLI explicitly unavailable', async () => {
  const value = await collectVersions({ processEntry: process.execPath })
  const own = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(value.plugin.value, own.version)
  assert.equal(value.node.value, process.versions.node)
  assert.equal(value.host.value, undefined)
  assert.equal(value.kernel.value, undefined)
})

test('runtime refresh replaces vanished host data, preserves config and exports version provenance in dump', async t => {
  const f = await fixture(t)
  const { ManagerRuntime } = await import('../../lib/types/host/manager-runtime.js')
  const env = { DSH_HOME: join(f.root, 'home'), DSH_AGENTS_HOME: join(f.root, 'agents'), DSH_BUNDLED_SKILL_DIR: join(f.root, 'bundled'), DSH_PROFILE_DIR: join(f.root, 'profile'), SKILL_MCP_PANEL_HOME: join(f.root, 'panel'), SKILL_MCP_PANEL_DUMP: join(f.root, 'dump.json') }
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  for (const [key,value] of Object.entries(env)) process.env[key] = value
  await fs.mkdir(env.SKILL_MCP_PANEL_HOME)
  const target = join(env.SKILL_MCP_PANEL_HOME, 'config.json'), raw = '{"version":1,"future":"preserve"}\n'
  await fs.writeFile(target, raw)
  let host = { hostDescriptor: () => ({ hostId: 'dsh-tui', hostVersion: '0.19.8' }) }
  const runtime = new ManagerRuntime({ get: name => name === 'tuiPluginHost' ? host : undefined })
  t.after(() => { runtime.dispose(); for (const [key,value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  await runtime.ensureFresh()
  assert.equal(runtime.snapshot().versions.host.value, '0.19.8')
  host = undefined; await runtime.refreshVersions()
  assert.equal(runtime.snapshot().versions.host.value, undefined, 'old host version is not retained')
  await runtime.dumpNow()
  const dump = JSON.parse(await fs.readFile(env.SKILL_MCP_PANEL_DUMP, 'utf8'))
  assert.equal(dump.versions.node.value, process.versions.node)
  assert.ok(dump.versions.host.reason)
  assert.equal(await fs.readFile(target, 'utf8'), raw)
  const previous = runtime.snapshot().versions, pending = runtime.refreshVersions()
  runtime.dispose(); await pending
  assert.equal(runtime.snapshot().versions, previous, 'disposed runtime ignores late result')
})
