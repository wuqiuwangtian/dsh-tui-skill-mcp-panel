import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { setTimeout as sleep } from 'node:timers/promises'
import * as panel from '../../lib/types/index.js'

const settle = () => sleep(20)

test('real Cordis activation releases registrations on service removal, recovers and deactivates cleanly', async () => {
  const root = new Context()
  const commands = new Map()
  const scenes = new Map()
  let panelFiber
  const register = (table) => (entry) => {
    const id = entry.id ?? entry.name
    assert.equal(table.has(id), false, `duplicate registration ${id}`)
    table.set(id, entry)
    return () => { table.delete(id) }
  }
  const commandProvider = (ctx) => { ctx.provide('commands', { register: register(commands) }) }
  const sceneProvider = (ctx) => { ctx.provide('tuiScenes', { register: register(scenes), open: (id) => scenes.has(id) }) }
  try {
    panelFiber = root.plugin(panel)
    await settle()
    assert.equal(commands.size, 0, 'panel waits for injected services')
    let sceneFiber = root.plugin(sceneProvider)
    let commandFiber = root.plugin(commandProvider)
    await settle()
    assert.equal(commands.size, 1)
    assert.equal(scenes.size, 1)
    assert.equal(commands.get('skill-mcp').handler().kind, 'success')

    await sceneFiber.dispose()
    await settle()
    assert.equal(scenes.size, 0, 'service removal releases its scene immediately')
    assert.equal(commands.get('skill-mcp').handler().kind, 'error', 'no stale scene service proxy')
    sceneFiber = root.plugin(sceneProvider)
    await settle()
    assert.equal(scenes.size, 1)
    assert.equal(commands.get('skill-mcp').handler().kind, 'success')

    await commandFiber.dispose()
    await settle()
    assert.equal(commands.size, 0, 'service removal releases its command immediately')
    commandFiber = root.plugin(commandProvider)
    await settle()
    assert.equal(commands.size, 1)

    await panelFiber.dispose()
    await settle()
    assert.equal(commands.size, 0)
    assert.equal(scenes.size, 0)
    panelFiber = root.plugin(panel)
    await settle()
    assert.equal(commands.size, 1, 'reactivation registers one command')
    assert.equal(scenes.size, 1, 'reactivation registers one scene')
    await panelFiber.dispose()
    assert.equal(commands.size, 0)
    assert.equal(scenes.size, 0)
    await sceneFiber.dispose()
    await commandFiber.dispose()
  } finally { await root.fiber.dispose() }
})
