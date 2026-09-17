<p align="center">
  <img src="images/icon.png" width="72" alt="Apus affinis">
</p>

<h1 align="center">Apus affinis</h1>

<p align="center">Your repositories push themselves, and you can see how each one is doing without leaving VS Code.</p>

<p align="center"><a href="README.es.md">Leer en español</a></p>

---

*Apus affinis* is the little swift, a relative of *Apus*. This extension brings [apus](https://github.com/miguelacaceresrios/Apus) into the editor. It watches your repositories, and when you stop touching one for a while, apus runs `add`, `commit` and `push`. The status bar shows whether there are changes waiting, how long until the next auto-commit, and when the last push happened.

## Features

- **Status bar.** Shows the apus icon with the state of the repository in the active editor:

  | Status bar | Meaning |
  |---|---|
  | apus + `10:48` | Up to date; last push at 10:48. |
  | apus + `3 · in 1:40` | 3 changes waiting; the next auto-commit runs in 1:40. |
  | apus + pause + `2` | Paused, with 2 changes. |
  | apus + spinning arrows | Pushing. |
  | apus + shield, on a yellow background | Held back: something that should not be pushed is about to go up. |
  | apus + unplugged cable | No URL to push to yet. |
  | apus + warning, on a yellow background | Something needs your attention. |

  Hover for details and quick actions (pause, push now, auto-commits). Click to open the menu.
- **Nothing sensitive goes up by accident.** Before every push, apus looks at what is about to leave your machine: `.env` files, private keys, tokens pasted into a file and files too big for GitHub. An auto-commit pushes nothing while one is there; a push by hand asks first. See [Check before push](#check-before-push).
- **Menu.** Push now, watch or pause, auto-commits; then the folder and the URL; then the rules and the log.
- **Apus view.** Adds its own icon to the activity bar. Each repository opens into a card: its folder, the URL it pushes to, its branch and its auto-commits, with a live countdown and inline actions. Click the folder or the URL to change it. The badge counts repositories with something unpushed.
- **Folder and URL.** *Add Folder…* looks at the folder before adding it: a plain folder can be initialized, a subfolder offers the root of its repository, and a folder with repositories inside asks which one you meant. *Connect or Change URL…* validates the URL and asks before changing it.
- **Errors you can fix.** No URL, repository not found, remote ahead: the notification and the view offer the fix, not just the message. If a repository's folder disappears, it stays on the list as *folder not found*, to locate it or forget it.
- **Notifications.** Choose every auto-commit, errors only, or nothing. A repeated error is not reported twice.
- **Early warning.** If apus is missing, the status bar and the view tell you right away and offer to download or locate it. You don't find out on your first push.
- **Get started guide.** A walkthrough on the Welcome page takes you from installing apus to your first watched repository.
- **English and Spanish.** The extension follows VS Code's display language.
- **Multi-root.** Works per git repository, not per workspace folder. Nested repositories work too.

## Requirements

- [apus](https://github.com/miguelacaceresrios/Apus) 2.1 or later, on your `PATH` or set in `apus.path`.
- VS Code's built-in Git extension.

If the extension can't find apus, it offers to download it or pick the binary. On Windows it must be `apus.exe`: `apusw.exe` is the windowed build and reports errors in dialog boxes.

## How it works

The extension does not reimplement git:

1. **Detects changes** through VS Code's built-in Git extension, so anything in `.gitignore` doesn't count.
2. **Waits** until the repository has been quiet for `apus.watchInterval` seconds. Every save restarts the wait.
3. **Checks** what the push would send: the new lines since the last commit, files git doesn't track yet, and commits that are on no remote. If something shouldn't go up, it stops here.
4. **Pushes** by running `apus --message "…"`. The binary is spawned without a shell, with stdin closed and `GIT_TERMINAL_PROMPT=0`, so it can never hang waiting for a password.
5. **Marks** each commit with the trailer `Apus-Auto: true`, so auto-commits can be recognized from the extension, the terminal or any other tool:

   ```bash
   git log --grep='^Apus-Auto: true$'
   ```

The time of the last push comes from the remote-tracking branch's reflog. The extension keeps no state files of its own: everything it shows is read from git.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `apus.autoStart` | `false` | Watch repositories as soon as they open. When off, each repository is watched by hand. |
| `apus.watchInterval` | `120` | Seconds without new changes before auto-committing. |
| `apus.minInterval` | `300` | Minimum seconds between two auto-commits of the same repository. |
| `apus.ignorePatterns` | `[]` | Globs whose changes don't trigger an auto-commit, like `*.log` or `docs/**`. |
| `apus.messageTemplate` | `chore: auto-commit {date}` | Auto-commit message. |
| `apus.checkBeforePush` | `true` | Check what is about to be pushed. User settings only. |
| `apus.maxFileSize` | `50` | Largest file, in MB, that can be pushed (GitHub rejects files over 100 MB). User settings only. |
| `apus.notifications` | `all` | What to notify: `all`, `errors` or `off`. |
| `apus.logSize` | `20` | How many auto-commits to list. |
| `apus.path` | *(empty)* | Path to the apus binary. Empty: search the `PATH`. User settings only. |

`apus.ignorePatterns` decides **when** to push, not **what** gets pushed. If there are other changes, apus runs `add -A` and the ignored files go in too. To keep files out of git, use `.gitignore`.

"User settings only" means a repository's `.vscode/settings.json` can't change it: a repository you clone can't turn off the check or point apus somewhere else.

## Commands

All of them are in the Command Palette under **Apus**, and most are one click away in the view or the menu.

| Command | What it does |
|---|---|
| Add Folder… | Adds a project folder to the list. A plain folder can be initialized; a folder with repositories inside asks which one. |
| Change Folder… | Points a repository of the list to another folder, and keeps it watched if it was. |
| Connect or Change URL… | Sets the URL a repository pushes to. |
| Watch or Pause a Repository | Turns auto-commit on or off, one repository at a time. |
| Push Now | add + commit + push right away, with the same check. |
| Review Held Files… | What stopped the last push, with a button to fix each one. |
| Review Files Let Through… | Findings you marked as not secret, to check them again. |
| Auto-commits | The latest auto-commits; pick one to open it on GitHub. |
| Remove from Apus | Takes a repository off the list and stops watching it. |
| Rules | The `apus.*` settings. |
| Show Log | What apus did, command by command, with tokens in URLs masked. |

## Check before push

A secret that reaches GitHub has to be treated as leaked, even if you delete it a minute later. Auto-commit runs `git add -A` with nobody looking, so before every push the extension looks at exactly what would go up:

- the lines added since the last commit, and the files git doesn't track yet (what `.gitignore` leaves out doesn't count);
- the commits that are on no remote yet, including the ones you made from the terminal or from Source Control.

| It holds back | Examples |
|---|---|
| Environment files | `.env`, `.env.local`, `prod.env` (not `.env.example`) |
| Keys and credential files | `id_rsa`, `id_ed25519`, `*.p12`, `*.pfx`, `*.jks`, `.netrc`, `.git-credentials`, `credentials.json`, `*.tfstate`, `*.kdbx` |
| Secrets inside a file | private key blocks; GitHub, GitLab, npm and Slack tokens; AWS access keys; Google, OpenAI and Anthropic API keys; Stripe live keys; URLs with a password (`postgres://user:pass@host`) |
| Big files | Over `apus.maxFileSize` (50 MB). GitHub rejects anything over 100 MB. |

Placeholders like `your-token-here`, `${DB_PASSWORD}` or `AKIA…EXAMPLE` don't count, and a secret that was already in the last commit isn't reported again on every change.

**When something turns up**, an auto-commit pushes nothing: the repository shows a shield, and a notification tells you what and where. A push by hand asks first, and you can push anyway. **Review Held Files…** lists each finding with its fix:

- **Add to .gitignore**, for a file git doesn't track yet.
- **Stop tracking it**, for a file already in git: it stays on your disk and goes into `.gitignore`.
- **Not a secret: let it through**, for a false positive. It is remembered per repository, and **Review Files Let Through…** undoes it.

If the secret is in a commit you haven't pushed, `.gitignore` can't take it out: undo that commit (`git reset --soft`) and commit again without it.

**What it doesn't do.** It recognizes the formats above, not every possible password. It can't take back a secret that was already pushed: change that secret. And pushing from apus's own window or terminal doesn't run this check yet. Keep GitHub's secret scanning and push protection on as well. The details are in [SECURITY.md](SECURITY.md).

## Safety

- **No auto-commit** while there are unresolved conflicts or `HEAD` is detached.
- **Untrusted workspaces:** the extension doesn't run. It needs VS Code's Git extension, which is disabled there.
- **Two windows on the same repository never push at once.** A lock lives in `.git/apus.lock`, and the minimum interval is computed from git, so it holds across windows.
- **Watching is off by default.** Pushing on its own should be your call, one repository at a time.
- **Watching belongs to a repository, not to a folder.** If you delete a repository and clone a different one into the same folder, the new one is not watched.
- **A repository inside another one gets a warning.** git pushes it as an empty pointer, not its files, so the extension says so before it happens.
- **Credentials stay out of sight.** URLs are shown without user or token, and a token that apus prints is replaced with `***` before it reaches the log or a notification.
- **Background pushes never ask for credentials.** No terminal prompt, no Git Credential Manager window, no SSH passphrase dialog: if credentials are missing, the push fails and a push by hand sorts it out.
- **Settings from a repository can't hang VS Code.** `apus.ignorePatterns` is matched without regular expressions, so no pattern can take minutes.

## Development

```
apus-affinis/
├── src/
│   ├── extension.ts        activation: wires the pieces together
│   ├── commands.ts
│   ├── config.ts           validated apus.* settings
│   ├── apusBinary.ts       where apus is, and what to do when it isn't
│   ├── core/               no VS Code imports, unit tested
│   │   ├── apus.ts         running apus and reading its output
│   │   ├── binary.ts       finding the binary
│   │   ├── git.ts          auto-commits, last push, remotes, init
│   │   ├── glob.ts         apus.ignorePatterns, without regular expressions
│   │   ├── inspect.ts      what a folder is before adding it
│   │   ├── lock.ts         cross-process lock
│   │   ├── process.ts      shell-free processes
│   │   ├── remote.ts       validating, showing and redacting URLs
│   │   ├── safety.ts       the check before push
│   │   ├── scheduler.ts    when to push
│   │   ├── stores.ts       watched repositories, added folders, findings let through
│   │   └── time.ts         localized times and countdowns
│   ├── git/api.ts          VS Code's Git extension API
│   ├── repos/              one controller per repository, and the registry
│   └── ui/                 status bar, view, menu, folder, URL and review flows, notifications
├── l10n/                   runtime translations
├── package.nls*.json       manifest translations
├── media/walkthrough/      theme-aware illustrations for the guide
├── images/                 Marketplace icon, activity bar icon, icon font
├── scripts/
│   ├── icons.mjs           builds the icons from the apus shape
│   └── integration.mjs     runs test/integration in your VS Code
└── test/
    ├── unit/               node:test, with real git in temp folders
    └── integration/        inside VS Code, with the Git extension and apus
```

```bash
npm install
npm test               # core unit tests + translation coverage
npm run test:integration  # inside a separate VS Code window (set APUS_EXE to push for real)
npm run compile        # typecheck + esbuild bundle into dist/
npm run l10n           # re-export strings after adding a message
npm run icons          # rebuild activity.svg and apus-icons.woff
npm run install-ext    # package the .vsix and install it into VS Code
```

Press **F5** to open a VS Code window with the extension loaded from source.

The unit tests never contain a real-looking secret: the fake tokens in `test/unit/safety.test.ts` are assembled at runtime, so neither the check nor GitHub's push protection trips on this repository.

## License

[MIT](LICENSE)
