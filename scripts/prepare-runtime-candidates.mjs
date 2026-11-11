/** Prepare isolated upstream MCP/host candidates; never mutate installed packages. */
import assert from 'node:assert/strict'
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [hostArg, webArg, releaseArg, variant] = process.argv.slice(2)
assert(hostArg && webArg && releaseArg, 'usage: node scripts/prepare-runtime-candidates.mjs <installed host> <installed web 2.3.7> <official web 2.3.12 directory> [--with-raw-recovery]')
assert(variant === undefined || variant === '--kernel-only' || variant === '--with-raw-recovery', 'unsupported variant')
const withRawRecovery = variant === '--with-raw-recovery'
const probe = JSON.parse(execFileSync(process.execPath, [join(here, 'prepare-web-release-probe.mjs'), hostArg, webArg, releaseArg, '--flow-candidate'], { encoding: 'utf8' }))
const kernel = dirname(dirname(await realpath(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())))
const mcpSource = await realpath(join(kernel, 'node_modules/@deepseek-ai/dsh-mcp-client'))
const hostSource = await realpath(hostArg)
const sources = { mcp: mcpSource, host: hostSource }, copies = {}, originals = {}
const files = { mcp: 'lib/index.js', host: 'lib/types/ink/components/App.js' }
for (const [kind, source] of Object.entries(sources)) {
  const target = join(probe.root, `${kind}-runtime-candidate`)
  await cp(source, target, { recursive: true, dereference: false, filter: path => path !== join(source, 'node_modules') })
  let checked = target
  assert(!(await lstat(checked)).isSymbolicLink(), 'candidate source must be a regular copy')
  for (const part of files[kind].split('/')) {
    checked = join(checked, part)
    assert(!(await lstat(checked)).isSymbolicLink(), 'candidate source must be a regular copy')
  }
  if (kind === 'mcp') await symlink(join(kernel, 'node_modules'), join(target, 'node_modules'))
  else {
    // The installed host resolves some dependencies from its own node_modules
    // and others from the profile ancestor. Preserve that exact resolution.
    const require = createRequire(join(source, 'package.json'))
    const linked = new Set()
    // Mirror nearest-first search roots, including optional/backend imports
    // not declared in the host manifest. This is a reuse probe, not an install.
    for (const base of require.resolve.paths('__runtime_probe__') ?? []) {
      let entries
      try { entries = await readdir(base) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      for (const entry of entries.filter(name => !name.startsWith('.'))) {
        const names = entry.startsWith('@') ? (await readdir(join(base, entry))).map(name => entry + '/' + name) : [entry]
        for (const name of names) {
          if (linked.has(name)) continue
          let directory
          try { directory = await realpath(join(base, name)) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
          try { await readFile(join(directory, 'package.json')) } catch { continue }
          const link = join(target, 'node_modules', name)
          await mkdir(dirname(link), { recursive: true }); await symlink(directory, link); linked.add(name)
        }
      }
    }
  }
  originals[kind] = await readFile(join(target, files[kind]), 'utf8')
  copies[kind] = target
}
assert.equal(JSON.parse(await readFile(join(copies.mcp, 'package.json'), 'utf8')).version, '0.2.2-rc.1')
const replaceOnce = (text, before, after) => { assert.equal(text.split(before).length, 2, 'reviewed source anchor mismatch'); return text.replace(before, after) }
let mcp = originals.mcp
mcp = 'import { drainMcpStderr } from "./panel-stderr-candidate.mjs";\n' + mcp
mcp = replaceOnce(mcp, 'function createTransport(config) {', 'function createTransport(config, onStderr) {')
mcp = replaceOnce(mcp, 'case "stdio": return new StdioClientTransport({', 'case "stdio": {\n\t\t\tconst transport = new StdioClientTransport({')
mcp = replaceOnce(mcp, '\t\t\tcwd: config.cwd\n\t\t});', `\t\t\tcwd: config.cwd,\n\t\t\tstderr: "pipe"\n\t\t});
\t\t\tconst finishStderr = drainMcpStderr(transport.stderr, onStderr, Object.values(config.env ?? {}));
\t\t\tconst close = transport.close.bind(transport);
\t\t\ttransport.close = async () => { try { await close(); } finally { finishStderr(); } };
\t\t\treturn transport;
\t\t}`)
mcp = replaceOnce(mcp, 'transport = createTransport(config);', 'transport = createTransport(config, line => ctx.logger.warn(`${label} stderr: ${line}`));')
const host = replaceOnce(originals.host, '        this.props.stdin.setRawMode(true);\n    };\n}', `        // Node may cache raw=true after another process changed termios.
        this.props.stdin.setRawMode(false);
        this.props.stdin.setRawMode(true);
    };
}`)
await writeFile(join(copies.mcp, files.mcp), mcp)
await cp(join(here, 'candidates/mcp-stderr.mjs'), join(copies.mcp, 'lib/panel-stderr-candidate.mjs'))
await writeFile(join(copies.host, files.host), host)
for (const [name, target] of [['@deepseek-ai/dsh-mcp-client', copies.mcp], ['@deepseek-harness-tui/dsh-tui', withRawRecovery ? copies.host : hostSource]]) {
  const link = join(probe.profile, 'node_modules', name)
  await mkdir(dirname(link), { recursive: true })
  try { assert((await lstat(link)).isSymbolicLink()); await rm(link) } catch (error) { if (error.code !== 'ENOENT') throw error }
  await symlink(target, link)
}
const patchPath = join(probe.profile, 'cordis.patch.yml')
const fixture = join(dirname(here), 'test/fixtures/mcp-stdio-server.mjs')
await writeFile(patchPath, `- insert:
    - id: mcp-flow
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        {
          serverName: mcp-flow,
          transport: stdio,
          command: ${JSON.stringify(process.execPath)},
          env: { FLOW_TEST: !!js '"fixture"' },
          args: [ ${JSON.stringify(fixture)} ]
        }
` + await readFile(patchPath, 'utf8'))
const rawTrace = join(probe.root, 'raw-calls.jsonl'), pidFile = join(probe.root, 'host-pid.txt')
const traceModule = join(probe.root, 'trace-raw.mjs')
await writeFile(traceModule, `import fs from 'node:fs'
import tty from 'node:tty'
const original = tty.ReadStream.prototype.setRawMode
tty.ReadStream.prototype.setRawMode = function(value) {
  const result = original.call(this, value)
  fs.appendFileSync(${JSON.stringify(rawTrace)}, JSON.stringify({pid:process.pid, requested:value, cachedRaw:this.isRaw, time:Date.now()})+'\\n')
  return result
}
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
`)
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
await writeFile(probe.launcher, (await readFile(probe.launcher, 'utf8')).replace(' --import ', ' --import ' + quote(traceModule) + ' --import '))
const result = { ...probe, sources, copies, files, rawTrace, pidFile, runtimeHost: withRawRecovery ? 'raw recovery candidate' : 'original unmodified host', coldStartServer: 'mcp-flow', originalSha256: Object.fromEntries(Object.entries(originals).map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')])), scope: 'isolated upstream proposals; existing dependency links; no installed changes or publication' }
await writeFile(join(probe.root, 'runtime-candidates.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
