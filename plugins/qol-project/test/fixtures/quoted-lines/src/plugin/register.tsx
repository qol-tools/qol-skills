const FORK = 'project-fork'
const NAME = 'qol-switchboard'
const PROJECT = /^\s*Project:\s*(.+?)\s*$/

on('turn.start', async ($, e, next) => {
  const sent = await sendTo($, entry, CONTINUE)
  if (key !== undefined) await recordPart($, key, agentId)
  return next(e)
})
