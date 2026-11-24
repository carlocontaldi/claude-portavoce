import type { EngineInterface, Register } from 'claude-code'

const USAGE = 'Use /portavoce topic, /portavoce topic new or /portavoce test.'
const WORDS = ['topic', 'topic new', 'test']

let topicOption = ''
let tokenOption = ''
let parrotOption = ''

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

// The script reads these options from its environment, as it does when a hook runs it.
const scriptEnv = () => ({
  ...(topicOption === '' ? {} : { CLAUDE_PLUGIN_OPTION_NTFY_TOPIC: topicOption }),
  ...(tokenOption === '' ? {} : { CLAUDE_PLUGIN_OPTION_NTFY_TOKEN: tokenOption }),
  ...(parrotOption === '' ? {} : { CLAUDE_PLUGIN_OPTION_SHOW_PARROT: parrotOption }),
})

const portavoce = ($: EngineInterface, args: string[]) =>
  interpreter($).then(command => $.process.run([command, `${$.plugin.root}/hooks/limit_restore_notify.py`, ...args], { env: scriptEnv() }))

export const register: Register = (on, options) => {
  python = undefined
  topicOption = String(options.ntfy_topic ?? '').trim()
  tokenOption = String(options.ntfy_token ?? '').trim()
  parrotOption = String(options.show_parrot ?? '').trim()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'portavoce',
      description: 'Show the ntfy topic to subscribe the phone to, or send a test push',
      argumentHint: 'topic|topic new|test',
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'portavoce' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    if (!WORDS.includes(words.join(' '))) return { text: USAGE }
    return { text: (await portavoce($, words)).stdout.trim() }
  })
}
