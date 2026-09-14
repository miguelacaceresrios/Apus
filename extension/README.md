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
  | apus + warning, on a yellow background | Something needs your attention. |

  Hover for details and quick actions (pause, push now, auto-commits). Click to open the menu.
- **Menu.** Watch or pause, push now, browse the latest auto-commits and open the rules.
- **Apus view.** Adds its own icon to the activity bar. Each repository gets a row with its state, a live countdown and inline actions. The badge counts repositories with something unpushed.
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
3. **Pushes** by running `apus --message "…"`. The binary is spawned without a shell, with stdin closed and `GIT_TERMINAL_PROMPT=0`, so it can never hang waiting for a password.
4. **Marks** each commit with the trailer `Apus-Auto: true`, so auto-commits can be recognized from the extension, the terminal or any other tool:

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
| `apus.notifications` | `all` | What to notify: `all`, `errors` or `off`. |
| `apus.logSize` | `20` | How many auto-commits to list. |
| `apus.path` | *(empty)* | Path to the apus binary. Empty: search the `PATH`. |

`apus.ignorePatterns` decides **when** to push, not **what** gets pushed. If there are other changes, apus runs `add -A` and the ignored files go in too. To keep files out of git, use `.gitignore`.

## Safety

- **No auto-commit** while there are unresolved conflicts, `HEAD` is detached or the workspace is untrusted.
- **Two windows on the same repository never push at once.** A lock lives in `.git/apus.lock`, and the minimum interval is computed from git, so it holds across windows.
- **`apus.path` is machine-scoped only.** A cloned repository can't point it at another executable from its `.vscode/settings.json`.
- **Watching is off by default.** Pushing on its own should be your call, one repository at a time.

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
│   │   ├── git.ts          auto-commits, last push, remote URL
│   │   ├── glob.ts         apus.ignorePatterns
│   │   ├── lock.ts         cross-process lock
│   │   ├── process.ts      shell-free processes
│   │   ├── scheduler.ts    when to push
│   │   └── time.ts         localized times and countdowns
│   ├── git/api.ts          VS Code's Git extension API
│   ├── repos/              one controller per repository, and the registry
│   └── ui/                 status bar, view, menu, notifications, texts
├── l10n/                   runtime translations
├── package.nls*.json       manifest translations
├── media/walkthrough/      theme-aware illustrations for the guide
├── images/                 Marketplace icon, activity bar icon, icon font
├── scripts/icons.mjs       builds the icons from the apus shape
└── test/unit/              node:test
```

```bash
npm install
npm test               # core unit tests + translation coverage
npm run compile        # typecheck + esbuild bundle into dist/
npm run l10n           # re-export strings after adding a message
npm run icons          # rebuild activity.svg and apus-icons.woff
npm run install-ext    # package the .vsix and install it into VS Code
```

Press **F5** to open a VS Code window with the extension loaded from source.

## License

[MIT](LICENSE)
