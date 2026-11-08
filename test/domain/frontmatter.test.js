import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSkillName, parseSkillDocument, splitFrontmatter } from '../../lib/types/domain/skills/index.js'

const valid = `---
name: my-skill
description: Does a thing.
whenToUse: When the thing is needed.
metadata:
  owner: me
---

# Body

Hello.
`

test('parseSkillDocument accepts a valid document and strips frontmatter from body', () => {
  const parsed = parseSkillDocument(valid)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.frontmatter.name, 'my-skill')
  assert.equal(parsed.frontmatter.description, 'Does a thing.')
  assert.equal(parsed.frontmatter.whenToUse, 'When the thing is needed.')
  assert.deepEqual(parsed.frontmatter.metadata, { owner: 'me' })
  assert.equal(parsed.frontmatter.modelInvocable, true)
  assert.equal(parsed.frontmatter.userInvocable, true)
  assert.equal(parsed.body.trim(), '# Body\n\nHello.')
})

test('missing frontmatter / raw body are rejected like the kernel', () => {
  assert.deepEqual(parseSkillDocument('# just markdown'), {
    ok: false,
    reason: 'missing YAML frontmatter',
  })
  assert.equal(parseSkillDocument('---\nname: x\n').ok, false)
  assert.deepEqual(parseSkillDocument('---\n- a\n- b\n---\nbody'), {
    ok: false,
    reason: 'missing YAML frontmatter',
  })
})

test('invalid YAML, missing fields and bad names carry kernel reasons', () => {
  const badYaml = parseSkillDocument('---\nname: [unclosed\n---\nbody')
  assert.equal(badYaml.ok, false)
  if (!badYaml.ok) assert.match(badYaml.reason, /^invalid YAML frontmatter: /u)

  const missingDescription = parseSkillDocument('---\nname: ok-name\n---\nbody')
  assert.deepEqual(missingDescription, {
    ok: false,
    reason: 'frontmatter requires name and description',
  })

  const badName = parseSkillDocument('---\nname: Not_Kebab\ndescription: d\n---\nbody')
  assert.deepEqual(badName, { ok: false, reason: 'invalid skill name "Not_Kebab"' })
})

test('skill name grammar matches the kernel (kebab-case)', () => {
  for (const name of ['a', 'a1', 'a-b', 'a-b-c', '1-2']) assert.equal(isSkillName(name), true, name)
  for (const name of ['', 'A', 'a_b', 'a b', '-a', 'a-', 'a--b', 'a.b', '技能']) {
    assert.equal(isSkillName(name), false, name)
  }
})

test('invocation frontmatter: canonical booleans, lexical values, legacy keys rejected', () => {
  const invocable = parseSkillDocument(
    '---\nname: n\ndescription: d\ndisable-model-invocation: yes\nuser-invocable: off\n---\nbody',
  )
  assert.equal(invocable.ok, true)
  if (invocable.ok) {
    assert.equal(invocable.frontmatter.modelInvocable, false)
    assert.equal(invocable.frontmatter.userInvocable, false)
  }

  const legacy = parseSkillDocument('---\nname: n\ndescription: d\ndisableModelInvocation: true\n---\nbody')
  assert.equal(legacy.ok, false)
  if (!legacy.ok) assert.match(legacy.reason, /unsupported; use "disable-model-invocation"/u)

  const badBoolean = parseSkillDocument('---\nname: n\ndescription: d\nuser-invocable: maybe\n---\nbody')
  assert.equal(badBoolean.ok, false)
  if (!badBoolean.ok) assert.match(badBoolean.reason, /must be a boolean/u)
})

test('splitFrontmatter tolerates CRLF and finds the closing fence', () => {
  const split = splitFrontmatter('---\r\nname: a\r\ndescription: d\r\n---\r\nbody\r\n')
  assert.deepEqual(split, { yaml: 'name: a\r\ndescription: d\r\n', body: 'body\r\n' })
})
