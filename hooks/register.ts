import type { EngineInterface, Register } from 'claude-code'

const HOOK_TIMEOUT_MS = 20_000
const USAGE = 'Use /portavoce topic, /portavoce topic new or /portavoce test.'
const WORDS = ['topic', 'topic new', 'test']

let optionEnv: Record<string, string> = {}

// `python3` where it runs, else `python`: a Windows install often has only `python`, a Linux one only `python3`.
let python: Promise<string> | undefined

const runs = async ($: EngineInterface, name: string) => {
  try {
    return (await $.process.run([name, '-c', ''])).exitCode === 0
  } catch {
    return false
  }
}

const pickPython = async ($: EngineInterface) => {
  if (await runs($, 'python3')) return 'python3'
  return (await runs($, 'python')) ? 'python' : 'python3'
}

const interpreter = ($: EngineInterface) => (python ??= pickPython($))

// The script reads the options from its environment, as it does when Claude Code runs it as a hook.
const portavoce = async ($: EngineInterface, args: string[], stdin?: string) =>
  $.process.run([await interpreter($), `${$.plugin.root}/hooks/limit_restore_notify.py`, ...args], {
    env: optionEnv,
    ...(stdin === undefined ? {} : { stdin, timeoutMs: HOOK_TIMEOUT_MS }),
  })

export const register: Register = (on, options) => {
  python = undefined
  optionEnv = Object.fromEntries(
    Object.entries(options).flatMap(([name, value]) => {
      const text = String(value ?? '').trim()
      return text === '' ? [] : [[`CLAUDE_PLUGIN_OPTION_${name.toUpperCase()}`, text]]
    }),
  )

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'portavoce',
      description: 'Show the ntfy topic to subscribe the phone to, or send a test push',
      argumentHint: 'topic|topic new|test',
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  // Second path for the StopFailure hook, with no shell; Claude Code skips it under an org's cc-plugin-sec-default,
  // so hooks.json carries the command hook too and the script runs once for both.
  on('classic.StopFailure', async ($, e, next) => {
    if (e.error === 'rate_limit') await portavoce($, [], JSON.stringify(e)).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'portavoce' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    if (!WORDS.includes(words.join(' '))) return { text: USAGE }
    return { text: (await portavoce($, words)).stdout.trim() }
  })
}
