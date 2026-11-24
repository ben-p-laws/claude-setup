import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'setup-queue',
  component: 'Pane',
  requestId: 'setup-queue',
  props: {
    title: 'Setup queue',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const item = (id: string) => ({
  id,
  name: `Name ${id}`,
  type: 'plugin',
  category: 'generic',
  summary: `Summary ${id}`,
  install: [`/plugin install ${id}@market`, `echo ${id}`],
})

const engine = (on: any, start: object, failClaude = false) => {
  let file = JSON.stringify(start)
  const runs: string[] = []
  const state = { opened: 0, closed: 0, get file() { return JSON.parse(file) }, runs, get logs() { return logs } }
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.exists', () => ({ value: true }))
  const logs: string[] = []
  on('fs.read', (_: any, e: any) => {
    if (!String(e.path).endsWith('pending.json')) throw new Error('ENOENT')
    return { value: file }
  })
  on('fs.write', (_: any, e: any) => {
    if (String(e.path).endsWith('pending.json')) file = e.text
    else logs.push(e.text)
    return { value: undefined }
  })
  // The session's Bash tool: the command's first line, then its exit marker.
  on('tool.call', (_: any, e: any) => {
    const command = String(e.command).split('\n')[0]
    runs.push(command)
    const fail = failClaude && command.includes("'plugin'")
    return {
      result: { stdout: `${fail ? 'nope' : 'ok'}\n__SETUP_QUEUE_EXIT=${fail ? 1 : 0}`, stderr: '' },
    }
  })
  on('ui.open', () => { state.opened++; return { value: { isPlaced: true } } })
  on('ui.close', () => { state.closed++; return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'setup-queue' } }))
  return state
}

const base = { version: 1, updated_at: '', installed: [], dismissed: [] }

test('an empty queue shows nothing', async ($, on) => {
  const s = engine(on, { ...base, pending: [] })
  const { text } = await $.command.run({ command: 'setup-queue' })
  expect(text).toBe('Nothing pending.')
  expect(s.opened).toBe(0)
})

test('install runs the steps, moves the item and pushes', async ($, on) => {
  const s = engine(on, { ...base, pending: [item('a'), item('b')] })
  await $.command.run({ command: 'setup-queue' })
  expect(s.opened).toBe(1)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Summary a/ }))?.text).toBe('Summary a')
    expect(await ui.find({ type: 'Button', key: 'install-all' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'install:a' })
  await ui.press({ key: 'dismiss:b' })
  await ui.unmount()

  const q = s.file
  expect(q.pending).toEqual([])
  expect(q.installed[0].id).toBe('a')
  expect(typeof q.installed[0].installed_at).toBe('string')
  expect(q.dismissed[0].id).toBe('b')
  expect(typeof q.dismissed[0].dismissed_at).toBe('string')

  const cmds = s.runs
  expect(cmds).toContain(`"\${CLAUDE_CODE_EXECPATH:-claude}" 'plugin' 'install' 'a@market'`)
  expect(cmds).toContain('echo a')
  expect(cmds.some(c => c.includes('echo b'))).toBe(false)
  expect(cmds.filter(c => c.endsWith("'push' '--quiet'")).length).toBe(2)
  expect(s.closed).toBeGreaterThan(0)
})

test('a failing step keeps the item pending', async ($, on) => {
  const s = engine(on, { ...base, pending: [item('a')] }, true)
  await $.command.run({ command: 'setup-queue' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'install:a' })
  expect((await ui.find({ type: 'Text', text: /nope/ }))).toBeDefined()
  await ui.unmount()
  expect(s.file.pending.length).toBe(1)
  expect(s.logs.join('')).toContain('nope')
})

test('other slash commands run in the session', async ($, on) => {
  const s = engine(on, { ...base, pending: [{ ...item('a'), install: ['/hello world'] }] })
  const ran: string[] = []
  on('command.run', (_: any, e: any) => {
    ran.push(`${e.command} ${e.args}`)
    return { text: 'hi' }
  })
  await $.command.run({ command: 'setup-queue' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'install:a' })
  await ui.unmount()
  expect(ran).toEqual(['hello world'])
  expect(s.file.installed[0].id).toBe('a')
})
