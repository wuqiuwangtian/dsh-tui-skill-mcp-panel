/** Inspect npm's actual file list and archive; no publish, registry write or user-profile install. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, posix } from 'node:path'
import { isBuiltin } from 'node:module'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'
import { checkManifest, json, repoRoot, sha256 } from './manifest.mjs'

const run = promisify(execFile)

export function parsePackReport(stdout) {
  const parsed = JSON.parse(stdout)
  // npm <= 11 emits an array; npm 12 keys the same records by package name.
  const records = Array.isArray(parsed) ? parsed : Object.values(parsed)
  assert.equal(records.length, 1, 'exactly one package')
  assert.ok(records[0] && Array.isArray(records[0].files), 'npm pack report contains a file list')
  return records[0]
}

async function sourceFiles(dir, prefix = '') {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = posix.join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(join(dir, entry.name), relative))
    else if (/\.tsx?$/u.test(entry.name)) files.push(relative)
  }
  return files
}

export async function expectedFiles(root = repoRoot) {
  const files = ['package.json', 'README.md', 'LICENSE', 'dsh-plugin.json', 'cordis.patch.yml']
  for (const path of await sourceFiles(join(root, 'src'))) {
    const stem = `lib/types/${path.replace(/\.tsx?$/u, '')}`
    files.push(`${stem}.js`, `${stem}.d.ts`, `${stem}.d.ts.map`)
  }
  return files.sort()
}

export function validatePackList(pack, expected, pkg) {
  assert.equal(pack.name, pkg.name, 'packed package identity')
  assert.equal(pack.version, pkg.version, 'packed package version')
  const paths = pack.files.map((file) => file.path).sort()
  assert.equal(new Set(paths).size, paths.length, 'no duplicate archive paths')
  assert.deepEqual(paths, [...expected].sort(), 'archive must contain exactly compiled sources + package/manifest/patch/README/LICENSE; no stale output, fixtures, credentials or node_modules')
  assert.ok(pack.files.every((file) => (Number(file.mode) & 0o111) === 0), 'no executable/native files in the plugin archive')
}

export function moduleSpecifiers(source, path) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const imports = []
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      assert.ok(ts.isStringLiteral(node.moduleSpecifier), `nonliteral module specifier in ${path}`)
      imports.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      assert.ok(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]), `nonliteral dynamic import in ${path}`)
      imports.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return imports
}

export function validateImports(path, specifiers, packaged, pkg) {
  const declared = { ...pkg.dependencies, ...pkg.peerDependencies }
  for (const specifier of specifiers) {
    if (isBuiltin(specifier)) continue
    if (specifier.startsWith('.')) {
      const target = posix.normalize(posix.join(posix.dirname(path), specifier))
      assert.ok(packaged.has(target), `${path}: missing relative runtime import ${specifier}`)
    } else {
      const parts = specifier.split('/')
      const dependency = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
      assert.ok(Object.hasOwn(declared, dependency), `${path}: undeclared runtime dependency ${dependency}`)
    }
  }
}

export async function checkTarball(root = repoRoot) {
  const temp = await mkdtemp(join(tmpdir(), 'skill-mcp-pack-'))
  try {
    const pkg = await json(join(root, 'package.json'))
    const expected = await expectedFiles(root)
    const npm = async (args) => {
      const { stdout } = await run('npm', ['pack', '--json', '--ignore-scripts', ...args], { cwd: root, maxBuffer: 8 * 1024 * 1024 })
      const result = parsePackReport(stdout)
      validatePackList(result, expected, pkg)
      return result
    }
    // Caller builds first; ignore lifecycle scripts to avoid recursion and hidden side effects.
    const dry = await npm(['--dry-run'])
    const packed = await npm(['--pack-destination', temp])
    assert.equal(packed.filename, basename(packed.filename), 'archive filename stays inside temporary output')
    const archive = join(temp, packed.filename)
    const bytes = await readFile(archive)
    const extracted = join(temp, 'extracted')
    await mkdir(extracted)
    await run('tar', ['-xzf', archive, '--strip-components=1', '-C', extracted])
    const extractedPkg = await json(join(extracted, 'package.json'))
    assert.deepEqual(extractedPkg, pkg, 'archive package metadata equals checked source metadata')
    const manifest = await checkManifest(extracted)
    const packaged = new Set(expected)
    for (const path of expected) {
      const source = await readFile(join(root, path))
      const artifact = await readFile(join(extracted, path))
      assert.ok(source.equals(artifact), `${path}: archive bytes differ from checked source/build`)
      if (path.endsWith('.js')) validateImports(path, moduleSpecifiers(artifact.toString('utf8'), path), packaged, pkg)
    }
    // Resolve declared dependencies from this locked checkout; this is an archive
    // import smoke, not proof of a clean registry install or host acceptance.
    await symlink(join(root, 'node_modules'), join(extracted, 'node_modules'), 'dir')
    const entry = await import(pathToFileURL(join(extracted, extractedPkg.main)).href)
    assert.equal(entry.name, pkg.name, 'Cordis plugin name export')
    assert.ok(entry.Config, 'Cordis Config export')
    assert.equal(typeof entry.apply, 'function', 'Cordis apply export')
    const diagnostics = await import(pathToFileURL(join(extracted, 'lib/types/host/versions.js')).href)
    const versions = await diagnostics.collectVersions({ processEntry: process.execPath })
    assert.equal(versions.plugin.value, extractedPkg.version, 'diagnostics uses extracted plugin metadata')
    assert.equal(versions.plugin.source, join(extracted, 'package.json'), 'no checkout metadata fallback')
    assert.equal(versions.node.value, process.versions.node)
    assert.equal(versions.host.value, undefined, 'headless archive import has no live host')
    assert.equal(versions.kernel.value, undefined, 'headless archive import has no confirmed DSH CLI')
    return { name: pkg.name, version: pkg.version, fileCount: packed.files.length, bytes: bytes.length,
      sha256: sha256(bytes), npmIntegrity: packed.integrity, dryRunFileCount: dry.files.length,
      manifestId: manifest.id, importSmoke: 'Cordis name/Config/apply from extracted archive with checkout dependencies',
      diagnosticVersionSmoke: 'plugin metadata from extracted package; Node actual; absent host/kernel unavailable',
      limits: 'not published; no registry-install, provenance or Verified claim; needs npm + tar' }
  } finally { await rm(temp, { recursive: true, force: true }) }
}
