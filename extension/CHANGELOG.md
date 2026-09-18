# Changelog

Notable changes to Apus affinis. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## 0.5.0 - 2026-09-18

- **Offline is not an error.** When the remote can't be reached, the repository shows a cloud instead of a warning, the commit stays on your machine, and apus tries again on its own after 1, 2 and 5 minutes, then every 10, while the repository is watched. Auto-commits say nothing; a push by hand says the commit is saved.
- **Auto-commit messages name their files.** The default `apus.messageTemplate` is now `chore: update {files}`, like `chore: update app.ts, README.md +2`, and the body lists every file with its status. `{date}` still works; a custom template is kept as it is.
- **Push Now in Source Control**, in the title bar of each git repository, and on <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd> (<kbd>⌘</kbd>+<kbd>⌥</kbd>+<kbd>P</kbd> on macOS).
- With apus 2.2 or later, the extension reads its `--json` output instead of its messages: errors are recognized by the reason apus gives, not by matching Spanish text. apus 2.1 still works as before.
- **Download apus** now downloads the binary for your system from apus's latest release (Windows, Linux or macOS, x64 or ARM), and then offers to choose it. No Go needed.
- Development: ESLint with type-aware rules and Prettier; coverage of the core in CI (at least 90% of lines); integration tests inside VS Code on Linux, Windows and macOS in CI; the repository controller split into smaller modules; GitHub Actions pinned by commit and kept up to date by Dependabot; a contributing guide and issue forms.

## 0.4.0 - 2026-09-17

**Security**

- **Check before push.** Before every push, the extension looks at what would go up: the lines added since the last commit, the files git doesn't track yet, and the commits that are on no remote, including those made from the terminal or Source Control. It holds back `.env` files, private keys, credential files, tokens and API keys pasted into a file (GitHub, GitLab, npm, Slack, AWS, Google, OpenAI, Anthropic, Stripe), URLs with a password, and files over `apus.maxFileSize`.
- An auto-commit with a finding pushes nothing: the repository shows a shield and a notification says what and where. A push by hand asks first.
- **Review Held Files…** lists each finding with its fix: add to `.gitignore`, stop tracking it (the file stays on disk), or let a false positive through. **Review Files Let Through…** undoes the last one.
- New settings `apus.checkBeforePush` and `apus.maxFileSize`. Like `apus.path`, a repository's `.vscode/settings.json` can't change them, and findings let through are stored by VS Code, not in a settings file.
- Tokens in remote URLs are masked in the log and in notifications. apus prints the URL as configured, so `https://user:token@github.com` used to end up in the log.
- Auto-commits never open a credential prompt: no Git Credential Manager window and no SSH passphrase dialog in the background.
- The input box for a URL starts empty when the current URL carries credentials.
- The manifest no longer claims limited support for untrusted workspaces: the Git extension doesn't run there, and neither does this one.
- CI runs with a read-only token.
- New [SECURITY.md](SECURITY.md): how to report a vulnerability, what the extension does on your machine, and its limits.

**Fixes**

- A pattern like `**/**/**/x` in `apus.ignorePatterns` could freeze the extension host for minutes. Patterns are now matched without regular expressions.

## 0.3.0 - 2026-09-17

- **Folder and URL, right in the view.** Each repository opens into a card with its folder, the URL it pushes to, its branch and its auto-commits. Click the folder or the URL to change it.
- **Add Folder…**, from the **+** in the view or from the menu. apus looks at the folder first: a repository is added as it is, a plain folder can be initialized, a subfolder offers the root of its repository, and a folder with repositories inside asks which one to add, instead of pushing empty pointers to GitHub.
- **Connect or change the URL** from the view, the menu or an error notification. It is validated like apus does, and changing it asks first.
- **Errors come with a fix.** No URL: *Connect URL…*. Repository not found: *Change URL…*. The remote has new commits: a terminal with `git pull --rebase` typed in, for you to run.
- A warning when a repository has another one inside, which git pushes as an empty pointer.
- **Remove from Apus**, with undo. Removed repositories can be brought back from *Add Folder…*.
- A shorter menu, grouped: actions, repository, apus.

**Fixes**

- The *Get started* illustrations showed up as black boxes. VS Code blocks CSS inside walkthrough SVGs, so their colors are attributes now.
- A deleted repository folder was reported as `spawn git ENOENT`, which reads as if git were missing, and apus kept retrying. It now shows as *folder not found*, with *Locate Folder…* and *Forget*.
- Deleting a repository and cloning a different one into the same folder kept it watched. Watching now belongs to the repository (its root commits), not to the folder.
- The warning from a failed push stayed until the next successful push. It now clears when you pause, change the URL, or push from somewhere else.
- A repository without a remote kept trying to auto-commit. It now waits for a URL.
- Two repositories with the same folder name looked identical.
- When apus was missing, the view hid every repository.
- With the Git extension disabled, the buttons in the guide failed with "command not found".
- `npm run l10n` called a binary that does not exist.

## 0.2.0 - 2026-09-14

- The apus icon in the status bar, from its own icon font, with a compact layout: last push time, or changes waiting and a live countdown to the next auto-commit.
- Quick actions in the status bar and view tooltips: pause or watch, push now, auto-commits.
- Live countdowns in the Apus view.
- Early warning when apus is missing: the status bar and the view say so right away and offer to download or locate it.
- Get started walkthrough, with theme-aware illustrations.
- English and Spanish, following VS Code's display language.
- Times and dates follow the display language too.

## 0.1.0 - 2026-09-14

- Status bar item for the active repository: watching, pending changes and last push time.
- Quick menu: watch or pause, push now, auto-commits and rules.
- **Apus** view in the activity bar, one row per repository with inline actions.
- Auto-commit with apus after a quiet period, with a minimum gap and a lock across windows.
- Auto-commits marked with the `Apus-Auto: true` trailer.
- Configurable notifications: all, errors only or none.
