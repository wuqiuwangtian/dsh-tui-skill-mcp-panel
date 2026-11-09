import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { checkManifest, json, loadAdmissionBaseline, repoRoot, validateManifestDocument } from '../../scripts/release/manifest.mjs'
import { expectedFiles, moduleSpecifiers, parsePackReport, validateImports, validatePackList } from '../../scripts/release/tarball.mjs'

test('pinned official parser, profile definitions and example descriptor accept the real package', async () => {
  const report = await checkManifest()
  assert.equal(report.id, 'com.dsh-tui.skill-mcp-panel')
  assert.equal(report.exampleDescriptorDecision, 'compatible')
  assert.ok(report.evidence.includes('not a Verified'))
})

test('manifest guard rejects drift in version, peer range, entry, permissions and scene declaration', async () => {
  const original = await json(join(repoRoot, 'dsh-plugin.json'))
  const pkg = await json(join(repoRoot, 'package.json'))
  const mutations = [
    (m) => { m.version = '9.0.0' },
    (m) => { m.compat.hosts = ['@deepseek-harness-tui/dsh-tui *'] },
    (m) => { m.facets.host.entry = 'src/index.ts' },
    (m) => { m.permissions = [{ name: 'commands.invoke', scope: 'skill-mcp', reason: 'unexpected grant' }] },
    (m) => { m.contributes['x-dsh-tui'][0].spec = { title: 'X', unknown: true } },
    (m) => { m.contributes['x-dsh-tui'] = [] },
    (m) => { m.requires.contracts = [{ apiVersion: 'tui.dsh/v1alpha1', kind: 'Scene' }] },
    (m) => { m.requires.contracts[0].optional = true },
  ]
  for (const mutate of mutations) {
    const raw = structuredClone(original)
    mutate(raw)
    await assert.rejects(validateManifestDocument(raw, pkg))
  }
})

test('Scene is a manifest extension, not a required host protocol', async () => {
  const { standard, official, index, hostDescriptor } = await loadAdmissionBaseline()
  const manifest = await json(join(repoRoot, 'dsh-plugin.json'))
  manifest.requires.contracts.push({ apiVersion: 'tui.dsh/v1alpha1', kind: 'Scene' })
  const result = standard.negotiate(index, official.parseManifest(JSON.stringify(manifest)), hostDescriptor)
  assert.equal(result.decision, 'rejected')
  assert.ok(result.missingRequired.includes('tui.dsh/v1alpha1#Scene'))
})

test('npm report supports array and npm 12 keyed formats but refuses multiple packages', () => {
  const pack = { name: 'test', files: [] }
  assert.deepEqual(parsePackReport(JSON.stringify([pack])), pack)
  assert.deepEqual(parsePackReport(JSON.stringify({ test: pack })), pack)
  assert.throws(() => parsePackReport(JSON.stringify([pack, pack])), /exactly one/u)
})

test('artifact allowlist rejects missing manifest, stale probes, private files and native payloads', async () => {
  const pkg = await json(join(repoRoot, 'package.json'))
  const expected = await expectedFiles()
  const pack = { name: pkg.name, version: pkg.version, files: expected.map((path) => ({ path, mode: 0o644 })) }
  validatePackList(pack, expected, pkg)
  assert.throws(() => validatePackList({ ...pack, files: pack.files.filter(({ path }) => path !== 'dsh-plugin.json') }, expected, pkg))
  for (const path of ['lib/types/host/probe-runtime.js', '.env', 'lib/token.json', '../escape', 'node_modules/react/index.js']) {
    assert.throws(() => validatePackList({ ...pack, files: [...pack.files, { path, mode: 0o644 }] }, expected, pkg))
  }
  assert.throws(() => validatePackList({ ...pack, files: pack.files.map((file, i) => i === 0 ? { ...file, mode: 0o755 } : file) }, expected, pkg))
})

test('runtime import closure rejects omitted relative modules and undeclared dependencies', () => {
  const paths = new Set(['lib/types/index.js', 'lib/types/domain/store.js'])
  const source = `// import fake from 'do-not-match-comments'\nimport fs from 'node:fs'; export { x } from './domain/store.js'; const lazy = import('yaml')`
  const specifiers = moduleSpecifiers(source, 'lib/types/index.js')
  assert.deepEqual(specifiers, ['node:fs', './domain/store.js', 'yaml'])
  validateImports('lib/types/index.js', specifiers, paths, { dependencies: { yaml: '^2.9.0' } })
  assert.throws(() => validateImports('lib/types/index.js', ['./missing.js'], paths, {}), /missing relative/u)
  assert.throws(() => validateImports('lib/types/index.js', ['@example/dev-only'], paths, { devDependencies: { '@example/dev-only': '*' } }), /undeclared runtime/u)
  assert.throws(() => moduleSpecifiers('import(userInput)', 'module.js'), /nonliteral dynamic import/u)
})
