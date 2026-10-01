# Poupou

A notch companion for Windows. Poupou, a small ghost with an antenna, lives at the top-centre of your
screen, follows your Claude Code sessions, lets you approve permission requests
from there, and chats with Claude **through the Claude subscription your
`claude` CLI is already signed in with** — no API key.

## Run it

Requirements: Node 20+, and Claude Code installed and signed in (`claude`, then
`/login`).

```powershell
npm install
npm run dev        # live-reloading
```

or, without the dev server:

```powershell
npm run build
npm start
```

There is no taskbar window. The island is at the top of the screen and there is
an icon in the notification area (Open, Ask Claude, Settings…, Pause, Quit).

## Using it

| What you do | What happens |
|---|---|
| Move the pointer to the very top-centre of the screen | the island peeks out |
| Click the small island | it opens |
| Click the chat tab, type, Enter | Claude answers, streamed, on your subscription |
| Ask it to run a command or edit a file | an **Allow / Deny** card appears first |
| Drag a file onto the island | it swallows the file, then offers to answer questions about it |
| Click the character | it gets annoyed; three times and it goes dizzy |
| `Esc` (while the chat has focus) | closes the island |

### Claude Code sessions

Tray icon → **Settings… → Install hooks…**. You are shown the exact diff to
`%USERPROFILE%\.claude\settings.json`, a dated backup is taken, and nothing is
written until you click. After that, sessions started in VS Code or any terminal
show up on the island step by step, and permission requests can be answered from
it. Sessions that were already open need a restart to pick the hooks up.

If Poupou is closed, the hook exits immediately — Claude Code is never blocked.
If nobody answers a permission card, Claude Code asks in the terminal as usual.

### Chat

Each message is one `claude -p` run; the conversation continues with `--resume`.

- **Ask me first** (default): reading and searching are free; anything else
  (shell commands, file edits) shows an Allow / Deny card on the island.
- **Read-only**: commands and edits are not available at all.

The chat works in your home folder unless you pick another one in Settings. Your
own Claude Code plugins, hooks and project settings are deliberately left out of
the chat, and `ANTHROPIC_API_KEY` is removed from its environment so it always
uses the subscription login.

## Layout

```
src/main/                 Electron main process
  island.ts               the transparent always-on-top window, click-through, cursor poll
  pipe.ts                 named-pipe server the hook relay talks to
  hooks.ts                installs / removes the hooks in ~/.claude/settings.json
  claude.ts               the chat: spawns the `claude` CLI and reads its stream
  tray.ts, store.ts       tray icon, settings file, log
src/preload/              the IPC bridge exposed to the pages
src/renderer/
  src/island/             the island (TypeScript + Canvas 2D, no framework)
  src/settings/           the settings window (React + Tailwind + shadcn/ui)
  src/components/ui/      shadcn components
resources/poupou-hook.cjs the relay Claude Code runs on each hook event
scripts/gen-sounds.mjs    synthesises the 28 sounds (npm run sounds)
```

Settings and the log live in `%APPDATA%\poupou\` (`settings.json`, `poupou.log`).

## Sounds

The sounds are synthesised by `scripts/gen-sounds.mjs` — sine "mallet" notes and
filtered noise, all in D major pentatonic so overlapping sounds never clash. To
retune one, edit its line in the script and run `npm run sounds`.

## Licences

Third-party code this app includes is listed in `THIRD-PARTY-NOTICES.txt`. That
file has to ship with every copy of the app.
