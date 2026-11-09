/** Development-only checks against the exact parser/profile shipped by our pinned host. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseDocument } from 'yaml'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const json = async (path) => JSON.parse(await readFile(path, 'utf8'))
export const sha256 = (value) => createHash('sha256').update(value).digest('hex')
let baseline

export async function loadAdmissionBaseline() {
  baseline ??= (async () => {
    const pin = await json(join(repoRoot, 'scripts/release/admission-pin.json'))
    const require = createRequire(import.meta.url)
    const hostManifest = require.resolve(`${pin.hostPackage}/package.json`)
    const hostRoot = dirname(hostManifest)
    const host = await json(hostManifest)
    assert.equal(host.version, pin.hostVersion, 'admission host version drift; review the pin before updating')
    const fromHost = createRequire(hostManifest)
    const entries = Object.fromEntries(['core', 'manifest'].map((name) => [name, fromHost.resolve(`@dsh-std/${name}`)]))
    const profileRoot = join(hostRoot, 'tui-profile')
    for (const [name, path] of Object.entries({ ...entries, registry: join(profileRoot, 'registry/registry-0.15.json') })) {
      assert.equal(sha256(await readFile(path)), pin.hashes[name], `${name} digest drift; do not silently use a different admission baseline`)
    }
    const standard = await import(pathToFileURL(join(hostRoot, 'lib/types/adapter/standard/index.js')).href)
    assert.equal(standard.DSH_STD_REVISION, pin.stdRevision, 'dsh-std revision drift')
    const data = standard.loadSpecData(profileRoot)
    assert.ok(data, 'host admission profile is missing or invalid')
    assert.equal(data.registry.profileVersion, pin.profileVersion)
    assert.deepEqual(standard.verifyRegistry(data), [], 'host definition/profile digest verification')
    assert.deepEqual(standard.verifyContractProfiles(data), [], 'host contract profiles')
    const index = standard.createContractIndex(data.registry, data.permissions)
    // This is an upstream example descriptor, NOT live support evidence.
    const hostDescriptor = await json(join(profileRoot, 'registry/host-descriptor.tui.example.json'))
    standard.validateHost(index, hostDescriptor)
    const official = await import(pathToFileURL(entries.manifest).href)
    return { pin, hostRoot, standard, official, index, hostDescriptor }
  })()
  return baseline
}

const same = (actual, expected, label) => assert.deepEqual(actual, expected, label)

export async function validateManifestDocument(raw, pkg) {
  const { pin, standard, official, index, hostDescriptor } = await loadAdmissionBaseline()
  const parsed = official.parseManifest(JSON.stringify(raw), { source: 'dsh-plugin.json' })
  standard.validatePlugin(index, parsed)
  for (const ref of parsed.requires.contracts) {
    assert.ok(index.protocols.understands(ref), `${ref.kind} is not a negotiable host protocol; declare scene extensions in contributes.x-dsh-tui`)
  }
  same(parsed.id, 'com.dsh-tui.skill-mcp-panel', 'stable plugin identity')
  same(parsed.name, pkg.name, 'package/manifest names')
  same(parsed.version, pkg.version, 'package/manifest versions')
  same(parsed.license, pkg.license, 'package/manifest license')
  same(parsed.facets.host, { entry: pkg.main, apiVersion: 'v1alpha1' }, 'host entry/API version')
  same(pkg.type, 'module', 'ESM package')
  same(pkg.main, 'lib/types/index.js', 'compiled plugin entry')
  same(pkg.types, 'lib/types/index.d.ts', 'compiled type entry')
  same(pkg.exports?.['.'], { types: `./${pkg.types}`, import: `./${pkg.main}` }, 'package exports')
  same(parsed.compat?.hosts, [`${pin.hostPackage} ${pkg.peerDependencies?.[pin.hostPackage]}`], 'manifest/peer host range')
  same(pkg.peerDependencies?.[pin.hostPackage], '>=0.19.0 <0.20.0', 'tested host compatibility range')
  same(parsed.permissions, [], 'D-8: no permission grants')
  same(parsed.subscriptions, [], 'no message/event subscriptions')
  same(parsed.requires, { contracts: [{ apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' }] }, 'runtime command registration dependency')
  same(parsed.contributes, { commands: [], panels: [], 'x-dsh-tui': [{
    apiVersion: 'tui.dsh/v1alpha1', kind: 'Scene', id: 'skill-mcp-panel', name: 'skill-mcp-panel', spec: { title: 'Skill / MCP manager' },
  }] }, 'scene contribution; slash command is registered at runtime, not a grant-gated standard command')
  same(parsed.source?.repository, pkg.repository?.url?.replace(/^git\+/u, '').replace(/\.git$/u, ''), 'source repository')
  assert.equal(parsed.artifact, undefined, 'no unbound Verified artifact claim')
  same(pkg.dsh?.bundle, { patch: './cordis.patch.yml' }, 'Cordis bundle entry')
  for (const file of ['lib', 'cordis.patch.yml', 'dsh-plugin.json']) assert.ok(pkg.files.includes(file), `package.files missing ${file}`)
  same(parsed.overrides?.map(({ target, kind }) => ({ target, kind })), [{ target: 'cordis.patch.yml', kind: 'patch' }], 'bundle patch disclosure')
  const decision = standard.negotiate(index, parsed, hostDescriptor)
  same(decision.decision, 'compatible', 'negotiation against the upstream example descriptor (not live proof)')
  return { manifest: parsed, report: { manifestVersion: parsed.manifestVersion, id: parsed.id, version: parsed.version,
    stdRevision: pin.stdRevision, hostVersion: pin.hostVersion, parserSha256: pin.hashes.manifest,
    registrySha256: pin.hashes.registry, exampleDescriptorDecision: decision.decision,
    evidence: 'parsed + semantic/profile checks + example negotiation; not a Verified claim or live host acceptance' } }
}

export async function checkManifest(root = repoRoot) {
  const pkg = await json(join(root, 'package.json'))
  const result = await validateManifestDocument(await json(join(root, 'dsh-plugin.json')), pkg)
  const patch = parseDocument(await readFile(join(root, 'cordis.patch.yml'), 'utf8'))
  assert.deepEqual(patch.errors, [], 'bundle patch parses')
  same(patch.toJS(), [{ insert: [{ id: 'skill-mcp-panel', name: pkg.name }] }], 'bundle inserts only its plugin row')
  return result.report
}
