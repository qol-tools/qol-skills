import type { Register } from 'claude-code'

const BLOCKED = 'UserPromptSubmit operation blocked by hook:'
const SCROLL_HINT = '↓ ctrl+x tab, then page down or ↓ to read on · esc goes back to the prompt'

export function wrapToRows(line: string, columns: number): string[] {
  const width = Math.max(1, Math.floor(columns))
  const rows: string[] = []
  let rest = line
  while (rest.length > width) {
    const space = rest.lastIndexOf(' ', width)
    if (space > 0) {
      rows.push(rest.slice(0, space))
      rest = rest.slice(space + 1)
    } else {
      rows.push(rest.slice(0, width))
      rest = rest.slice(width)
    }
  }
  rows.push(rest)
  return rows
}

export function hintRow(rowCount: number, offset: number, bodyRows: number, maxRows: number): number {
  return rowCount > maxRows && offset + bodyRows < rowCount ? offset + bodyRows - 1 : -1
}

export const register: Register = on => {
  let consumed: string | undefined
  let typed: string | undefined
  let answer: string | null = null

  on('prompt.submit', async ($, e, next) => {
    if (answer !== null) {
      answer = null
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    if (result.block !== undefined && result.suppressOriginalPrompt === true) {
      consumed = e.prompt
      typed = e.prompt.trim()
      answer = result.block.trimEnd()
      $.ui.invalidate('ui.render')
    } else {
      consumed = undefined
      typed = undefined
    }
    return result
  })

  on('session.append', { door: 'notice' }, async ($, e, next) => {
    const [block] = e.message.content
    if (typed === undefined || block?.type !== 'text' || !block.text.startsWith(BLOCKED)) return next(e)
    const line = typed
    typed = undefined
    return next({ ...e, message: { ...e.message, content: [{ type: 'text', text: line }] } })
  })

  on('prompt.change', { origin: { kind: 'engine' } }, async ($, e, next) => {
    const result = await next(e)
    const restored = consumed !== undefined && e.text === consumed
    consumed = undefined
    if (restored) await $.prompt.fill({ text: '', mode: 'replace' })
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (answer === null || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const rows = answer.split('\n').flatMap(line => wrapToRows(line, e.props.bodyColumns))
    const { offset, bodyRows } = e.props.scroll
    const hintAt = hintRow(rows.length, offset, bodyRows, e.props.maxRows)
    return h(
      Box,
      { flexDirection: 'column' },
      ...rows.map((row, index) =>
        index === hintAt
          ? h(Text, { key: String(index), dimColor: true, wrap: 'truncate' }, SCROLL_HINT)
          : h(Text, { key: String(index) }, row === '' ? ' ' : row),
      ),
    )
  })
}
