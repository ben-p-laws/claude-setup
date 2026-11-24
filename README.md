# claude-setup

Install queue for Ben's Claude setup.

The daily **Claude Skill Scout** task (runs 6:38am Adelaide) suggests new skills, plugins and MCP servers. Anything Ben approves on his phone that can't be installed from mobile lands in `pending.json`. When Ben next opens Claude Code on his PC, a mod or startup hook reads this file and offers to install everything pending.

## pending.json

```json
{
  "version": 1,
  "updated_at": "ISO timestamp of last change",
  "pending":   [ /* approved, not yet installed */ ],
  "installed": [ /* moved here after install, with installed_at */ ],
  "dismissed": [ /* approved then skipped on PC, with dismissed_at */ ]
}
```

Each item:

```json
{
  "id": "owner-repo-name",            // stable, unique, kebab-case
  "name": "Display name",
  "type": "plugin | skill | mcp",
  "category": "generic | design | gaming | other",
  "summary": "What it does, one line",
  "why": "Why it fits, one line",
  "source_url": "https://github.com/owner/repo",
  "approved_at": "ISO timestamp",
  "install": [
    "/plugin marketplace add owner/repo",
    "/plugin install name@marketplace"
  ],
  "vetting": "Maintainer, last update, stars/installs, any flags"
}
```

## Rules

- The scout only ever **adds** to `pending`. It never installs anything.
- The PC side moves items from `pending` to `installed` (or `dismissed`) and commits.
- Skills saved from the phone's skill cards are already on Ben's account and don't go in here.

## The setup-queue plugin

`plugins/setup-queue` is the PC side: on each Claude Code start it pulls this repo, and if `pending` isn't empty it opens a **Setup queue** panel with Install / Dismiss per item and Install all. Install runs the item's `install` lines through the session's Bash tool (`/plugin …` and `/mcp …` become `claude plugin …` / `claude mcp …`), then moves it to `installed`; Dismiss moves it to `dismissed`. Each change is committed and pushed. `/setup-queue` re-checks on demand; step output is logged to `~/.claude/setup-queue.log`.

Install once per machine, from a shell:

```bash
claude plugin marketplace add ben-p-laws/claude-setup
claude plugin install setup-queue@claude-setup
```

The plugin expects this repo cloned at `~/claude-setup` (it clones it there if missing) with push access over HTTPS.
