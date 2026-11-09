/** Local, deterministic MCP fixture. No network or persisted data. */
import { createInterface } from 'node:readline'

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  let result
  if (request.method === 'initialize') {
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'panel-local-fixture', version: '1.0.0' },
    }
  } else if (request.method === 'tools/list') {
    result = { tools: [{ name: 'ping', description: 'Return a local verification message', inputSchema: { type: 'object', properties: {} } }] }
  } else if (request.method === 'tools/call') {
    result = { content: [{ type: 'text', text: 'panel-local-fixture OK' }] }
  } else if (request.method === 'ping') {
    result = {}
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
})
