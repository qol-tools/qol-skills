import type { Register } from 'claude-code'

export const register: Register = (on) => {
  let consumed: string | undefined

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    consumed = result.block !== undefined && result.suppressOriginalPrompt === true ? e.prompt : undefined
    return result
  })

  on('prompt.change', async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind !== 'engine') return result
    const restored = consumed !== undefined && e.text === consumed
    consumed = undefined
    if (restored) await $.prompt.fill({ text: '' })
    return result
  })
}
