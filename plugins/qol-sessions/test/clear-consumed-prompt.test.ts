import type { ClassicResultOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const fields = { session_id: 's', transcript_path: '/t', cwd: '/', permission_mode: 'default' }

type On = Parameters<Parameters<typeof test>[1]>[1]

function engine(on: On, block: ClassicResultOf['classic.UserPromptSubmit']) {
  const fills: string[] = []
  on('classic.UserPromptSubmit', () => block)
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('prompt.fill', (_, e) => (fills.push(e.text), { isFilled: true }))
  return fills
}

test('a prompt a hook consumed is cleared when the box gets it back', async ($, on) => {
  const fills = engine(on, { block: 'qols fork: k', suppressOriginalPrompt: true })

  await $.classic.UserPromptSubmit({ ...fields, prompt: 'qols fork x' })
  await $.prompt.change({ text: 'qols fork x', cursor: 11, origin: { kind: 'engine' } })

  expect(fills).toEqual([''])
})

test('a block that echoes the prompt leaves it in the box to fix', async ($, on) => {
  const fills = engine(on, { block: 'unknown command' })

  await $.classic.UserPromptSubmit({ ...fields, prompt: 'qols bogus' })
  await $.prompt.change({ text: 'qols bogus', cursor: 10, origin: { kind: 'engine' } })

  expect(fills).toEqual([])
})

test('only the next engine write is cleared, and only when it is the consumed prompt', async ($, on) => {
  const fills = engine(on, { block: 'qols fork: k', suppressOriginalPrompt: true })

  await $.classic.UserPromptSubmit({ ...fields, prompt: 'qols fork x' })
  await $.prompt.change({ text: 'qols fork x', cursor: 11, origin: { kind: 'history' } })
  await $.prompt.change({ text: 'other', cursor: 5, origin: { kind: 'engine' } })
  await $.prompt.change({ text: 'qols fork x', cursor: 11, origin: { kind: 'engine' } })

  expect(fills).toEqual([])
})
