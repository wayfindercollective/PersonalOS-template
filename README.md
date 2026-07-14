# PersonalOS Template

A **self-hosted personal AI assistant** you run on your own computer. Chat with it over **Telegram** (optional Discord / WhatsApp). It can use Claude Code, local models (Ollama, LM Studio / LiteLLM), and Grok.

Works on **Linux, macOS, and Windows** (Node.js 20+).

This repository is a **public starter template**:

- No API keys
- No chat history  
- No personal profile data

Clone it, add *your* identity and secrets, and keep your live instance private.

---

## Requirements

| Requirement | Notes |
|-------------|--------|
| **Node.js 20+** | [nodejs.org](https://nodejs.org/) or your package manager |
| **Claude Code CLI** | [Install docs](https://docs.anthropic.com/en/docs/claude-code) — used for the default agent |
| **Telegram account** | Free bot via [@BotFather](https://t.me/BotFather) |
| Git | Any recent Git (Windows: [Git for Windows](https://git-scm.com/) includes a useful terminal) |

Optional later: Ollama, LM Studio, Google Cloud OAuth, Discord bot, local Whisper for voice.

---

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/wayfindercollective/PersonalOS-template.git PersonalOS
cd PersonalOS
npm install
```

### 2. Configure

```bash
cp .env.example .env
cp CLAUDE.md.example CLAUDE.md
```

Edit **`CLAUDE.md`** — replace `[Your Name]` / `[Assistant Name]` with your details.

Edit **`.env`** (or use the wizard):

```bash
npm run setup
```

Minimum `.env` values:

```env
TELEGRAM_BOT_TOKEN=from-BotFather
ALLOWED_CHAT_ID=your-numeric-chat-id
```

Message your bot `/chatid` after first start if you need the chat id, then set `ALLOWED_CHAT_ID` and restart. **Without it, anyone who finds the bot can use your tools.**

### 3. Build and run

```bash
npm run build
npm start
```

For development:

```bash
npm run dev
```

Keep the process running (terminal, [pm2](https://pm2.keymetrics.io/), Windows Task Scheduler, launchd, systemd — your choice).

---

## Platform notes

### Linux

- Default shell tools work out of the box.
- Optional helper scripts under `scripts/*.sh` are bash.

### macOS

- Same as Linux for Node/npm.
- Optional Apple Reminders/Notes tools only if you set `MAC_SSH_TARGET` (usually leave unset).

### Windows

- Use **PowerShell**, **cmd**, or **Git Bash** for `npm` commands.
- Install Node.js from nodejs.org (includes npm).
- Claude Code CLI must be on your `PATH`.
- Bash helper scripts (`scripts/*.sh`) need **Git Bash** or **WSL**; the main app does **not** require them.
- Prefer WSL2 if you want a full Linux-like environment.


### Native modules

Core install needs a prebuilt **better-sqlite3** binary (npm usually downloads one for Node 20 LTS on common platforms).

Optional Discord voice decoding uses `@discordjs/opus` (listed under `optionalDependencies`). If install skips it, Telegram still works; Discord voice receive will log a warning until you install build tools (`make`, `g++`, python) and re-run `npm install`.

Prefer **Node 20 LTS** for best prebuild coverage. Node 22+ also works when prebuilds exist.


---

## What you get

| Path | Purpose |
|------|---------|
| `src/` | Bot, agent, model backends, integrations |
| `scripts/setup.ts` | Interactive setup wizard |
| `scripts/status.ts` | Health check |
| `skills/` | Agent skills (e.g. presentations) |
| `workspace/` | Your notes/projects (local; not for public git) |
| `store/` | Tokens/sessions (gitignored) |
| `CLAUDE.md` | Agent personality & identity (**you** edit this) |
| `.env` | Secrets (**never commit**) |

### Models

Telegram commands (once running), for example:

- `/model opus` (or other Claude models via Claude Code)
- `/model lmstudio` — needs `LMSTUDIO_URL` (and key if your proxy requires it)
- `/model ollama` — needs a local or remote Ollama
- `/model grok` — needs `XAI_API_KEY` or Grok CLI login

### Optional integrations

See `.env.example` for:

- Google Calendar / Gmail OAuth  
- Discord  
- WhatsApp bridge  
- Whisper STT WebSocket  
- Presentation server port  
- Optional remote SSH target  

None of these are required for a basic Telegram + Claude setup.

---

## Security

1. **Always set `ALLOWED_CHAT_ID`.**
2. Never commit `.env` or files under `store/`.
3. Back up *your* running copy to a **private** git remote — not this public template.
4. Only run the bot on machines you trust (it can run shell tools).

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run setup` | Interactive first-time config |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm start` | Run compiled bot |
| `npm run dev` | Run via `tsx` without pre-build |
| `npm run status` | Check config / connectivity |
| `npm test` | Unit tests |

---

## Updating from this template

If you forked or cloned and want code updates later, merge carefully and **never** overwrite your `.env` or `CLAUDE.md` with template placeholders.

---

## License

Starter code for your own private assistant. Fork freely; keep secrets out of git.
