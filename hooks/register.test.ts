import { expect, mock, test } from 'claude-code/testing'

const REQUIRED = { notify_email: 'me@example.com', ntfy_token: 'tk_fake' }

const slash = (args: string) => ({
  command: 'portavoce',
  args,
  origin: { kind: 'composer' },
  uuid: 'u1',
}) as const

// The engine beneath the plugin: a command registry and the script, answering with what it was asked and the env it got.
const world = (on: Parameters<typeof mock.clock>[0]) => {
  const runs: { argv: readonly string[]; env?: Record<string, string>; stdin?: string }[] = []
  const python = { hasPython3: true }
  on('command.register', () => ({ value: { command: 'portavoce' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.StopFailure', () => ({}))
  on('process.run', (_, e) => {
    if (e.argv[1] === '-c') {
      const exitCode = e.argv[0] === 'python3' && !python.hasPython3 ? 127 : 0
      return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    runs.push({ argv: e.argv, env: e.init?.env, stdin: e.init?.stdin })
    const stdout = `ran ${e.argv.slice(2).join(' ')}\n`
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { runs, python }
}

test('/portavoce topic, topic new and test run the script and show what it says', { options: REQUIRED }, async ($, on) => {
  const { runs } = world(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })

  expect((await $.command.run(slash('topic'))).text).toBe('ran topic')
  expect((await $.command.run(slash('topic new'))).text).toBe('ran topic new')
  expect((await $.command.run(slash('  test '))).text).toBe('ran test')
  expect(runs.map(run => run.argv.slice(2))).toEqual([['topic'], ['topic', 'new'], ['test']])
  expect(runs[0]?.argv[1]).toMatch(/hooks\/limit_restore_notify\.py$/)
})

test('the script runs under python3 when it runs', { options: REQUIRED }, async ($, on) => {
  const { runs } = world(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.command.run(slash('topic'))
  expect(runs.map(run => run.argv[0])).toEqual(['python3'])
})

test('the script runs under python when python3 does not', { options: REQUIRED }, async ($, on) => {
  const { runs, python } = world(on)
  python.hasPython3 = false
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.command.run(slash('topic'))
  await $.command.run(slash('test'))
  expect(runs.map(run => run.argv[0])).toEqual(['python', 'python'])
})

test('/portavoce with anything else says how to use it and runs nothing', { options: REQUIRED }, async ($, on) => {
  const { runs } = world(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })

  expect((await $.command.run(slash(''))).text).toBe('Use /portavoce topic, /portavoce topic new or /portavoce test.')
  expect((await $.command.run(slash('topic now'))).text).toBe('Use /portavoce topic, /portavoce topic new or /portavoce test.')
  expect(runs).toEqual([])
})

test('an unset topic option sends the script no topic variable, only what is set and the parrot default', { options: REQUIRED }, async ($, on) => {
  const { runs } = world(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.command.run(slash('topic'))
  expect(runs[0]?.env).toEqual({
    CLAUDE_PLUGIN_OPTION_NOTIFY_EMAIL: 'me@example.com',
    CLAUDE_PLUGIN_OPTION_NTFY_TOKEN: 'tk_fake',
    CLAUDE_PLUGIN_OPTION_SHOW_PARROT: 'true',
  })
})

test('the parrot option reaches the script', { options: { ...REQUIRED, show_parrot: false } }, async ($, on) => {
  const { runs } = world(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.command.run(slash('test'))
  expect(runs[0]?.env?.CLAUDE_PLUGIN_OPTION_SHOW_PARROT).toBe('false')
})

test('a topic set in the options reaches the script', { options: { ...REQUIRED, ntfy_topic: ' my-topic ' } }, async ($, on) => {
  const { runs } = world(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.command.run(slash('topic'))
  expect(runs[0]?.env).toEqual({
    CLAUDE_PLUGIN_OPTION_NOTIFY_EMAIL: 'me@example.com',
    CLAUDE_PLUGIN_OPTION_NTFY_TOPIC: 'my-topic',
    CLAUDE_PLUGIN_OPTION_NTFY_TOKEN: 'tk_fake',
    CLAUDE_PLUGIN_OPTION_SHOW_PARROT: 'true',
  })
})

test('a rate-limit stop runs the script with the hook input on its stdin and every option set', { options: { ...REQUIRED, delay_seconds: '30' } }, async ($, on) => {
  const { runs } = world(on)
  await $.classic.StopFailure({ error: 'rate_limit', session_id: 's1', transcript_path: '/t.jsonl' })

  const [run] = runs
  expect(runs).toHaveLength(1)
  expect(run?.argv.slice(2)).toEqual([])
  expect(run?.argv[1]).toMatch(/hooks\/limit_restore_notify\.py$/)
  expect(JSON.parse(run?.stdin ?? '{}')).toMatchObject({ error: 'rate_limit', session_id: 's1', transcript_path: '/t.jsonl' })
  expect(run?.env).toMatchObject({ CLAUDE_PLUGIN_OPTION_NOTIFY_EMAIL: 'me@example.com', CLAUDE_PLUGIN_OPTION_DELAY_SECONDS: '30' })
})

test('a stop that is no rate limit runs nothing', { options: REQUIRED }, async ($, on) => {
  const { runs } = world(on)
  await $.classic.StopFailure({ error: 'overloaded', session_id: 's1', transcript_path: '/t.jsonl' })
  expect(runs).toEqual([])
})

test('a script that cannot run does not stop the session', { options: REQUIRED }, async ($, on) => {
  on('classic.StopFailure', () => ({}))
  on('process.run', () => {
    throw new Error('no such file')
  })
  await $.classic.StopFailure({ error: 'rate_limit', session_id: 's1', transcript_path: '/t.jsonl' })
})
