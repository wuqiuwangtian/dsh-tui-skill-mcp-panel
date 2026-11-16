/** Actual CLI MCP SDK over loopback HTTP. Not a model turn or complete UI proof. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const cli = await realpath(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
const require = createRequire(cli)
const entry = require.resolve('@modelcontextprotocol/client')
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(entry).href)
const root = await mkdtemp(join(tmpdir(), 'skill-mcp-http-protocol-'))
const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/mcp-http-server.mjs'), root], { stdio: 'ignore' })
const stopped = new Promise(resolve => {
  child.once('exit', (code, signal) => resolve({ code, signal }))
  child.once('error', error => resolve({ error: String(error) }))
})
let client
try {
  let endpoint
  for (let attempt = 0; attempt < 100; attempt++) {
    try { endpoint = JSON.parse(await readFile(join(root, 'http-fixture.json'), 'utf8')); break }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    await sleep(50)
  }
  assert.ok(endpoint, 'local HTTP fixture must become ready')
  const rejected = await fetch(endpoint.url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) })
  assert.equal(rejected.status, 401, 'missing authentication header is refused')
  client = new Client({ name: 'panel-http-protocol-probe', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { 'X-Panel-Test-Token': 'http-fixture-not-a-secret' } },
  }), { timeout: 5000 })
  const tools = await client.listTools(undefined, { timeout: 5000 })
  assert.deepEqual(tools.tools.map(tool => tool.name), ['ping'])
  const response = await client.callTool({ name: 'ping', arguments: {} }, { timeout: 5000 })
  assert.deepEqual(response.content, [{ type: 'text', text: 'panel-http-fixture OK' }])
  await client.close()
  client = undefined
  let records = []
  // The server writes metadata after ending each response; wait for the last call.
  for (let attempt = 0; attempt < 100; attempt++) {
    records = (await readFile(join(root, 'http-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    if (records.some(row => row.rpcMethod === 'tools/call')) break
    await sleep(50)
  }
  for (const method of ['initialize', 'tools/list', 'tools/call']) {
    assert.ok(records.some(row => row.rpcMethod === method && row.headerMatched && row.status === 200), method)
  }
  assert.ok(!JSON.stringify(records).includes('http-fixture-not-a-secret'), 'request log never stores the header value')
  console.log(JSON.stringify({ check: 'actual-cli-http-mcp-protocol', ok: true, sdkEntry: entry,
    tools: tools.tools.map(tool => tool.name), missingHeaderStatus: rejected.status, requests: records,
    scope: 'loopback protocol/authentication/tool call, no model or UI; actual panel form evidence is separate' }, null, 2))
} finally {
  await client?.close().catch(() => {})
  child.kill('SIGTERM')
  await stopped
  await rm(root, { recursive: true, force: true })
}
