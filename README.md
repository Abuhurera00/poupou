# Poupou

A notch companion for Windows and macOS. Poupou, a small ghost with an antenna,
lives at the top-centre of your screen, follows your Claude Code sessions, lets
you approve permission requests from there, and chats with Claude — through the
Claude subscription your `claude` CLI is signed in with, or an Anthropic API
key.

## Download

| Your computer | Installer |
|---|---|
| **Windows** 10 / 11 | [Poupou-Windows-Setup.exe](https://github.com/Abuhurera00/poupou/releases/latest/download/Poupou-Windows-Setup.exe) |
| **Mac** with Apple Silicon (M1 and later) | [Poupou-macOS-arm64.dmg](https://github.com/Abuhurera00/poupou/releases/latest/download/Poupou-macOS-arm64.dmg) |
| **Mac** with an Intel processor | [Poupou-macOS-x64.dmg](https://github.com/Abuhurera00/poupou/releases/latest/download/Poupou-macOS-x64.dmg) |

All versions: [Releases](https://github.com/Abuhurera00/poupou/releases).

**Windows** — run the installer. It installs for your account only (no admin
prompt), adds Poupou to the Start menu and the desktop, and starts it. After
that, press the Windows key, type `Poupou`, Enter. The installer is not
signed, so Windows may show "Windows protected your PC": click **More info →
Run anyway**.

**macOS** — open the `.dmg` and drag Poupou to Applications. The app is not
signed by Apple, so macOS refuses the first launch; allow it once in Terminal:

```
xattr -cr /Applications/Poupou.app
```

then open Poupou from Spotlight or Launchpad. The Mac version is built
automatically but has **not been tried on a real Mac yet** — if the island sits
wrong at the top of the screen, `src/main/island.ts` is the place to look.

**To chat**, Poupou needs one of:

- **A Claude subscription** — [Claude Code](https://claude.com/claude-code)
  installed and signed in (run `claude`, then `/login`). This is the default.
- **An Anthropic API key** — Settings → Chat → *Connect with: Anthropic API
  key*, paste a key from [console.anthropic.com](https://console.anthropic.com/settings/keys).
  With Claude Code installed the chat can still read files and run commands
  (with your OK); without it, the chat answers and searches the web.

Following Claude Code sessions and approving their permission requests from the
island needs Claude Code either way (Settings → Install hooks).

There is no taskbar or Dock window. The island is at the top of the screen and
there is an icon in the notification area / menu bar (Open, Ask Claude, Talk to
Claude, Settings…, Start with Windows, Pause, Quit).

- **Start with Windows** (Open at login on a Mac): tick it in the tray menu or
  in Settings → Island.
- **Quit**: the ⏻ button in the island's top-right corner, *Quit* in the
  island's settings card, the button at the bottom of the Settings window, or
  the tray menu.
- **More than one screen**: the island follows the pointer — when it is hidden,
  it waits at the top-centre of whichever screen the pointer is on. Settings →
  Island → Display can pin it to the main display instead.

To update: download and run the newest installer. To remove: uninstall "Poupou" from Windows Settings → Apps, or delete it from
Applications on a Mac.

## Build it yourself

You need [Node 20+](https://nodejs.org).

```
git clone https://github.com/Abuhurera00/poupou.git
cd poupou
npm install
npm run dist
```

The installer for the computer you run it on lands in `dist/`. A Mac build has
to be made on a Mac.

**Publishing a release:** bump `version` in `package.json`, commit, then
`git tag vX.Y.Z && git push origin vX.Y.Z`. The *Release* GitHub Action builds
the Windows and both Mac installers and attaches them to the release, which is
where the download links above point.

## Run it from the code

```
npm install
npm run dev        # live-reloading
```

Quit the installed app first — only one Poupou runs at a time.

## Using it

| What you do | What happens |
|---|---|
| Move the pointer to the very top-centre of any screen | the island peeks out |
| Click the small island | it opens |
| Click the chat tab, type, Enter | Claude answers, streamed, on your subscription |
| `Ctrl+Shift+Space` anywhere, talk, press it again | your words are typed into the chat |
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
Claude Code also asks in the terminal at the same time; answer in either place.
When you answer in the terminal, the card on the island goes away by itself.

### Chat

With Claude Code installed, each message is one `claude -p` run and the
conversation continues with `--resume` — on your subscription login, or billed to
your API key if you chose one (Settings → Chat → Connect with). With an API key
and no Claude Code, messages go to the Anthropic API directly (Claude Opus 5.5
by default), with web search but no access to your files.

- **Ask me first** (default): reading and searching are free; anything else
  (shell commands, file edits) shows an Allow / Deny card on the island.
- **Read-only**: commands and edits are not available at all.

The chat works in your home folder unless you pick another one in Settings. Your
own Claude Code plugins, hooks and project settings are deliberately left out of
the chat. In subscription mode any `ANTHROPIC_API_KEY` in your environment is
ignored, so it always uses the subscription. A saved API key is encrypted by the
operating system (DPAPI on Windows, Keychain on macOS) and never shown again.

### Voice

Click the microphone in the chat bar, or press **Ctrl+Shift+Space** from any
app (also in the tray menu as *Talk to Claude*). Talk, then click or press it
again; `Esc` cancels. The text lands in the chat box so you can check it before
sending — or switch on *Send as soon as it's written* in Settings → Voice.

Speech is turned into text **on your computer** by OpenAI's Whisper model,
running in WebAssembly: no API key, and the audio never leaves the machine. The
model is downloaded from Hugging Face the first time you use voice (about 130 MB
for the default size; Settings → Voice has a smaller and a more accurate one)
and works offline after that.

On a Mac, macOS asks for microphone access the first time. On Windows, if
nothing is heard, check Settings → Privacy & security → Microphone → *Let
desktop apps access your microphone*.

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
  src/island/voice/       microphone recording and the Whisper worker
  src/settings/           the settings window (React + Tailwind + shadcn/ui)
  src/components/ui/      shadcn components
  platform.ts             the Windows / macOS differences
resources/poupou-hook.cjs the relay Claude Code runs on each hook event
scripts/gen-sounds.mjs    synthesises the 28 sounds (npm run sounds)
scripts/gen-icon.mjs      draws build/icon.png, the app icon (npm run icon)
```

Settings and the log (`settings.json`, `poupou.log`) live in `%APPDATA%\Poupou\`
on Windows and `~/Library/Application Support/Poupou/` on a Mac.

## Sounds

The sounds are synthesised by `scripts/gen-sounds.mjs` — sine "mallet" notes and
filtered noise, all in D major pentatonic so overlapping sounds never clash. To
retune one, edit its line in the script and run `npm run sounds`.

## Licence

MIT — see `LICENSE`. Copyright (c) 2026 Abuhurera00.
