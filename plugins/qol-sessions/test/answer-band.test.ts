import type { ClassicResultOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { hintRow, wrapToRows } from '../hooks/answer-band.ts'

const fields = { session_id: 's', transcript_path: '/t', cwd: '/', permission_mode: 'default' }
const HINT = '↓ ctrl+x tab, then page down or ↓ to read on · esc goes back to the prompt'

type Body = Parameters<Parameters<typeof test>[1]>[0]
type On = Parameters<Parameters<typeof test>[1]>[1]

function engine(on: On, block: ClassicResultOf['classic.UserPromptSubmit']) {
  const fills: string[] = []
  on('classic.UserPromptSubmit', () => block)
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('prompt.fill', (_, e) => (fills.push(e.text), { isFilled: true }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'engine' }, 'engine')
  })
  return fills
}

const props = (over = {}) => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
  ...over,
})

async function band($: Body, over = {}) {
  const ui = await $.ui.mount({ plugin: 'qol-sessions', surface: 'terminal', component: 'AbovePrompt', props: props(over) })
  const rows = (await ui.findAll({ type: 'Text' })).map(row => row.text)
  await ui.unmount()
  return rows
}

const answered = (block: string) => ({ block, suppressOriginalPrompt: true as const })

test('a prompt a hook consumed is cleared when the box gets it back', async ($, on) => {
  const fills = engine(on, answered('qols fork: k'))

  await $.classic.UserPromptSubmit({ ...fields, prompt: 'qols fork x' })
  await $.prompt.change({ text: 'qols fork x', cursor: 11, origin: { kind: 'engine' } })

  expect(fills).toEqual([''])
})

test('a block that echoes the prompt leaves it in the box to fix', async ($, on) => {
  const fills = engine(on, { block: 'unknown command' })

  await $.classic.UserPromptSubmit({ ...fields, prompt: 'qols bogus' })
  await $.prompt.change({ text: 'qols bogus', cursor: 10, origin: { kind: 'engine' } })

  expect(fills).toEqual([])
  expect(await band($)).toEqual(['engine'])
})

test('a usage or failed answer keeps the typed line in the box and draws no band', async ($, on) => {
  const fills = engine(on, { block: 'usage: qac gate [--cwd DIR]' })

  await $.classic.UserPromptSubmit({ ...fields, prompt: 'qac gate --bogus' })
  await $.prompt.change({ text: 'qac gate --bogus', cursor: 16, origin: { kind: 'engine' } })
  expect(fills).toEqual([])
  expect(await band($)).toEqual(['engine'])

  await $.classic.UserPromptSubmit({ ...fields, prompt: 'qac gate' })
  await $.prompt.change({ text: 'qac gate', cursor: 8, origin: { kind: 'engine' } })
  expect(fills).toEqual([])
  expect(await band($)).toEqual(['engine'])
})

test('only the next engine write is cleared, and only when it is the consumed prompt', async ($, on) => {
  const fills = engine(on, answered('qols fork: k'))

  await $.classic.UserPromptSubmit({ ...fields, prompt: 'qols fork x' })
  await $.prompt.change({ text: 'qols fork x', cursor: 11, origin: { kind: 'history' } })
  await $.prompt.change({ text: 'other', cursor: 5, origin: { kind: 'engine' } })
  await $.prompt.change({ text: 'qols fork x', cursor: 11, origin: { kind: 'engine' } })

  expect(fills).toEqual([])
})

test('any plugin verb that is answered and suppressed is cleared, not only qols', async ($, on) => {
  const fills = engine(on, answered('qac lint: 0 findings'))

  await $.classic.UserPromptSubmit({ ...fields, prompt: 'qac lint' })
  await $.prompt.change({ text: 'qac lint', cursor: 8, origin: { kind: 'engine' } })

  expect(fills).toEqual([''])
})

test('the answer shows above the prompt, one row per line', async ($, on) => {
  engine(on, answered('2 runs\nlatest passed\n'))

  await $.classic.UserPromptSubmit({ ...fields, prompt: 'qols loop' })

  expect(await band($)).toEqual(['2 runs', 'latest passed'])
})

test('an empty answer line still takes a row', async ($, on) => {
  engine(on, answered('verbs\n\nstatus'))

  await $.classic.UserPromptSubmit({ ...fields, prompt: 'qols loop' })

  const rows = await band($)
  expect(rows.length).toBe(3)
  expect(rows[0]).toBe('verbs')
  expect(rows[1]?.trim()).toBe('')
  expect(rows[2]).toBe('status')
})

test('the next submit clears the answer', async ($, on) => {
  engine(on, answered('2 runs'))

  await $.classic.UserPromptSubmit({ ...fields, prompt: 'qols loop' })
  expect(await band($)).toEqual(['2 runs'])

  await $.prompt.submit({ text: 'fix the loader', wait: false, origin: { kind: 'composer' } })
  expect(await band($)).toEqual(['engine'])
})

test('the band yields to a survey', async ($, on) => {
  engine(on, answered('2 runs'))

  await $.classic.UserPromptSubmit({ ...fields, prompt: 'qols loop' })

  expect(await band($, { hasSurvey: true })).toEqual(['engine'])
})

test('a long answer wraps to the band width and shows the scroll hint on the last visible row', async ($, on) => {
  engine(on, answered(Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n')))

  await $.classic.UserPromptSubmit({ ...fields, prompt: 'qols loop' })

  const rows = await band($, { maxRows: 5, scroll: { offset: 0, bodyRows: 4 } })
  expect(rows.length).toBe(12)
  expect(rows[3]).toBe(HINT)
  expect(rows[4]).toBe('line 4')

  const end = await band($, { maxRows: 5, scroll: { offset: 8, bodyRows: 4 } })
  expect(end.includes(HINT)).toBe(false)

  const narrow = await band($, { bodyColumns: 4 })
  expect(narrow.slice(0, 4)).toEqual(['line', '0', 'line', '1'])
})

test('wrapToRows breaks at the last space inside the width', () => {
  expect(wrapToRows('', 10)).toEqual([''])
  expect(wrapToRows('short', 10)).toEqual(['short'])
  expect(wrapToRows('one two three four', 9)).toEqual(['one two', 'three', 'four'])
  expect(wrapToRows('abcdefghij', 10)).toEqual(['abcdefghij'])
  expect(wrapToRows('abcde fghij', 5)).toEqual(['abcde', 'fghij'])
})

test('wrapToRows hard-breaks a word longer than the width', () => {
  expect(wrapToRows('abcdefghijkl', 5)).toEqual(['abcde', 'fghij', 'kl'])
  expect(wrapToRows('ab', 0)).toEqual(['a', 'b'])
})

test('every wrapped row fits the width', () => {
  const line = 'judge eslint failed with 3 blocking findings in src/loader/cache.mjs and two advisories'
  for (const width of [7, 13, 20, 31]) {
    for (const row of wrapToRows(line, width)) expect(row.length <= width).toBe(true)
  }
})

test('the hint sits on the last visible row only while rows run past the window', () => {
  expect(hintRow(5, 0, 9, 10)).toBe(-1)
  expect(hintRow(10, 0, 9, 10)).toBe(-1)
  expect(hintRow(20, 0, 9, 10)).toBe(8)
  expect(hintRow(20, 5, 9, 10)).toBe(13)
  expect(hintRow(20, 11, 9, 10)).toBe(-1)
})
