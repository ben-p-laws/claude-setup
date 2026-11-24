import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { QueueItem, QueueView } from '../types'

const PANE = 'setup-queue'
const TITLE = 'Setup queue'
const REMOTE = 'https://github.com/ben-p-laws/claude-setup.git'

const view = atom(
  { plugin: 'setup-queue', key: 'view' } as const,
  { pending: [], busy: null, message: null } as QueueView,
  { shape: 'view-1' },
)

type Queue = {
  version: number
  updated_at: string
  pending: QueueItem[]
  installed: QueueItem[]
  dismissed: QueueItem[]
}

type Dollar = Parameters<Hook<'session.start'>>[0]

// Every change to pending.json runs one at a time.
let chain: Promise<unknown> = Promise.resolve()
const serial = <T,>(work: () => Promise<T>): Promise<T> => {
  const run = chain.then(work, work)
  chain = run.catch(() => undefined)
  return run
}

const repoPath = async ($: Dollar): Promise<string> =>
  `${(await $.env.get('HOME')) ?? ''}/claude-setup`

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// Runs a shell command through the session's own Bash tool, the way Claude
// runs one: processes the mod starts itself fail `claude plugin install`.
// Falls back to a child process where the tool can't be called.
const bash = async (
  $: Dollar,
  command: string,
  timeoutMs = 300_000,
): Promise<{ code: number; out: string }> => {
  const MARK = '__SETUP_QUEUE_EXIT='
  try {
    const res = await $.tool.call({
      tool: 'Bash',
      command: `${command}\necho "${MARK}$?"`,
      description: 'Setup queue',
      timeout: timeoutMs,
    })
    if (res.deny !== undefined) return { code: 1, out: `denied: ${res.deny}` }
    const r = (res.result ?? {}) as { stdout?: string; stderr?: string }
    const all = r.stdout || r.stderr ? `${r.stdout ?? ''}\n${r.stderr ?? ''}` : (res.text ?? '')
    const m = all.match(new RegExp(`${MARK}(\\d+)`))
    const out = all.replace(new RegExp(`${MARK}\\d+`, 'g'), '').trim()
    return { code: m ? Number(m[1]) : res.isError ? 1 : 0, out }
  } catch {
    const run = await $.process.run(['/bin/sh', '-lc', command], { timeoutMs })
    return { code: run.exitCode, out: `${run.stdout}\n${run.stderr}`.trim() }
  }
}

const git = async ($: Dollar, repo: string, args: string[]) => {
  const { code, out } = await bash(
    $,
    ['git', '-C', repo, ...args].map(quote).join(' '),
    120_000,
  )
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${out}`)
  return out
}

const readQueue = async ($: Dollar, repo: string): Promise<Queue> => {
  const q = JSON.parse(await $.fs.read(`${repo}/pending.json`)) as Queue
  return {
    version: q.version ?? 1,
    updated_at: q.updated_at ?? '',
    pending: q.pending ?? [],
    installed: q.installed ?? [],
    dismissed: q.dismissed ?? [],
  }
}

const show = async ($: Dollar, q: Queue, message: string | null) => {
  await update($, view, v => ({ ...v, pending: q.pending, message }))
  if (q.pending.length > 0) await $.ui.open({ id: PANE, title: TITLE })
  else await $.ui.close({ id: PANE }).catch(() => undefined)
}

const refresh = ($: Dollar) =>
  serial(async () => {
    const repo = await repoPath($)
    try {
      if (await $.fs.exists(`${repo}/.git`)) {
        await git($, repo, ['pull', '--ff-only', '--quiet'])
      } else {
        const home = repo.slice(0, repo.lastIndexOf('/'))
        await git($, home, ['clone', '--quiet', REMOTE, repo])
      }
    } catch (err) {
      $.ui.log(`setup-queue: ${String(err)}`, { to: 'debug' })
    }
    const q = await readQueue($, repo)
    await show($, q, null)
    return q.pending.length
  })

// Appends a failure to ~/.claude/setup-queue.log, kept to the last 200 lines.
const logFailure = async ($: Dollar, text: string) => {
  const path = `${(await $.env.get('HOME')) ?? ''}/.claude/setup-queue.log`
  const old = await $.fs.read(path).catch(() => '')
  const lines = `${old}${new Date().toISOString()} ${text}\n`.split('\n')
  await $.fs.write(path, lines.slice(-200).join('\n')).catch(() => undefined)
}

// `/plugin …` and `/mcp …` run as `claude plugin …` / `claude mcp …` (the
// session's own Claude Code); other slash commands run in the session as if
// typed; anything else runs as a shell command.
const runStep = async ($: Dollar, step: string) => {
  const line = step.trim()
  let command = line
  if (line.startsWith('/')) {
    const [name = '', ...rest] = line.slice(1).split(/\s+/)
    if (name !== 'plugin' && name !== 'mcp') {
      await $.command.run({ command: name, args: rest.join(' ') })
      return
    }
    command = `"\${CLAUDE_CODE_EXECPATH:-claude}" ${[name, ...rest].map(quote).join(' ')}`
  }
  const { code, out } = await bash($, command)
  await logFailure($, `ran ${line} → exit ${code}: ${out.replace(/\n/g, ' | ')}`)
  if (code !== 0) throw new Error(`${line}: ${out}`)
}

const settle = (
  $: Dollar,
  ids: string[],
  outcome: 'installed' | 'dismissed',
) =>
  serial(async () => {
    const repo = await repoPath($)
    await git($, repo, ['pull', '--ff-only', '--quiet']).catch(() => undefined)
    const q = await readQueue($, repo)
    const done: string[] = []
    let failure: string | null = null

    for (const id of ids) {
      const item = q.pending.find(p => p.id === id)
      if (!item) continue
      await update($, view, v => ({ ...v, busy: id, message: null }))
      if (outcome === 'installed') {
        try {
          for (const step of item.install ?? []) await runStep($, step)
        } catch (err) {
          failure = `${item.name}: ${String(err)}`
          await logFailure($, failure)
          break
        }
      }
      const now = new Date().toISOString()
      q.pending = q.pending.filter(p => p.id !== id)
      q[outcome].push({
        ...item,
        [outcome === 'installed' ? 'installed_at' : 'dismissed_at']: now,
      })
      q.updated_at = now
      done.push(item.name)
    }

    let message = failure
    if (done.length > 0) {
      await $.fs.write(`${repo}/pending.json`, `${JSON.stringify(q, null, 2)}\n`)
      try {
        await git($, repo, ['add', 'pending.json'])
        await git($, repo, [
          'commit',
          '--quiet',
          '-m',
          `${outcome === 'installed' ? 'Install' : 'Dismiss'}: ${done.join(', ')}`,
        ])
        await git($, repo, ['pull', '--rebase', '--quiet'])
        await git($, repo, ['push', '--quiet'])
      } catch (err) {
        message = `${failure ? `${failure}\n` : ''}Saved locally, push failed: ${String(err)}`
        await logFailure($, message)
      }
      $.ui.toast(
        `${outcome === 'installed' ? 'Installed' : 'Dismissed'} ${done.join(', ')}`,
      )
    }
    await update($, view, v => ({ ...v, busy: null }))
    await show($, q, message)
  })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'setup-queue',
      description: 'Check claude-setup for pending installs',
    })
    void refresh($).catch(err =>
      $.ui.log(`setup-queue: ${String(err)}`, { to: 'debug' }),
    )
    return started
  })

  on('command.run', { command: 'setup-queue' }, async $ => {
    const count = await refresh($)
    return {
      text: count > 0 ? `${count} pending item(s).` : 'Nothing pending.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const idle = v.busy === null

    return (
      <Box flexDirection="column" gap={1}>
        {v.pending.length === 0 && <Text dimColor>Nothing pending.</Text>}
        {v.pending.map(item => (
          <Box flexDirection="column">
            <Text bold>
              {item.name} <Text dimColor>· {item.type}</Text>
            </Text>
            {item.summary ? <Text>{item.summary}</Text> : null}
            {v.busy === item.id ? (
              <Text dimColor>Working…</Text>
            ) : (
              <Box flexDirection="row" gap={1}>
                <Button
                  key={`install:${item.id}`}
                  label="Install"
                  onPress={() => {
                    if (idle) void settle($, [item.id], 'installed')
                  }}
                />
                <Button
                  key={`dismiss:${item.id}`}
                  label="Dismiss"
                  onPress={() => {
                    if (idle) void settle($, [item.id], 'dismissed')
                  }}
                />
              </Box>
            )}
          </Box>
        ))}
        {v.pending.length > 1 && idle && (
          <Button
            key="install-all"
            label="Install all"
            onPress={() =>
              void settle($, v.pending.map(p => p.id), 'installed')
            }
          />
        )}
        {v.message ? <Text color="red">{v.message}</Text> : null}
      </Box>
    )
  })
}
