/** Local stateless Streamable HTTP fixture; records metadata, never header values. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

assert.ok(process.argv[2], 'usage: mcp-http-server.mjs <owned output directory>')
const root = resolve(process.argv[2])
await mkdir(root, { recursive: true })
const token = 'http-fixture-not-a-secret'
let sequence = 0
const server = createServer(async (req, res) => {
  let request
  let status = 200
  const headerMatched = req.headers['x-panel-test-token'] === token
  try {
    if (new URL(req.url, 'http://127.0.0.1').pathname !== '/mcp') { status = 404; res.writeHead(status).end(); return }
    if (!headerMatched) { status = 401; res.writeHead(status).end(); return }
    if (req.method === 'DELETE') { status = 204; res.writeHead(status).end(); return }
    if (req.method !== 'POST') { status = 405; res.writeHead(status, { Allow: 'POST, DELETE' }).end(); return }
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (Buffer.byteLength(body) > 1024 * 1024) { status = 413; res.writeHead(status).end(); return }
    }
    request = JSON.parse(body)
    if (request.id === undefined) { status = 202; res.writeHead(status).end(); return }
    let result
    if (request.method === 'initialize') {
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'panel-local-http-fixture', version: '1.0.0' } }
    } else if (request.method === 'tools/list') {
      result = { tools: [{ name: 'ping', description: 'Return a local HTTP verification message',
        inputSchema: { type: 'object', properties: {} } }] }
    } else if (request.method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'panel-http-fixture OK' }] }
    } else if (request.method === 'ping') {
      result = {}
    } else {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' },
      }))
      return
    }
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
  } catch {
    status = 400
    if (!res.headersSent) res.writeHead(status)
    res.end()
  } finally {
    // Keep only a boolean for authentication: no request/response bodies or secrets.
    await appendFile(join(root, 'http-requests.jsonl'), JSON.stringify({ sequence: ++sequence,
      method: req.method, path: req.url, rpcMethod: request?.method, headerMatched, status }) + '\n', { mode: 0o600 })
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
await writeFile(join(root, 'http-fixture.json'), JSON.stringify({ pid: process.pid,
  url: `http://127.0.0.1:${server.address().port}/mcp` }, null, 2) + '\n', { mode: 0o600 })
const stop = () => { server.close(() => process.exit(0)); server.closeAllConnections() }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
