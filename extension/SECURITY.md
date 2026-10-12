# Security

[Leer en español](SECURITY.es.md)

Apus affinis commits and pushes your code without asking every time. That is only acceptable if it can't be turned against you: by a repository you clone, by a secret you forgot in a folder, or by a token in a log. This page describes what the extension does on your machine, what it protects against, and where it stops.

## Reporting a vulnerability

Please don't open a public issue. Use **Report a vulnerability** in the **Security** tab of this repository, which sends a private report. Include the extension version (Extensions view → Apus affinis), your operating system and the steps to reproduce it.

Only the latest version receives fixes.

## What the extension does on your machine

- **It runs two programs:** `git`, the same one VS Code's Git extension uses, and `apus`, from `apus.path` or your `PATH`. Both are spawned without a shell and with standard input closed, so nothing in a file name, a commit message or a URL is ever interpreted as a command.
- **It writes to a repository only** when you turned watching on for it (commit and push, through apus) or when you click an action: `git init`, `git remote add` or `set-url`, `git rm --cached`, and a line added to `.gitignore`.
- **It remembers, in VS Code's own storage:** which repositories are watched (with their root commit, so a different repository cloned into the same folder isn't), the folders you added in each window, and the findings you let through. It keeps no files of its own.
- **It doesn't connect to anything by itself.** git and apus do the pushing. There is no telemetry.

## What comes from a repository is untrusted

Repository contents, a repository's `.vscode/settings.json`, file names, commit messages, remote URLs and everything git or apus print are treated as untrusted input.

| Risk | What the extension does |
|---|---|
| A cloned repository points the extension at another executable | `apus.path` is machine-scoped: VS Code ignores it in workspace settings. |
| A cloned repository turns the check off, or lets its own `.env` through | `apus.checkBeforePush` and `apus.maxFileSize` are machine-scoped. Findings let through live in VS Code's global state, not in a settings file. |
| A pattern in `apus.ignorePatterns` hangs VS Code | Patterns are matched segment by segment, without regular expressions, in time proportional to pattern × path. Patterns over 1000 characters or 64 brace alternatives are rejected. |
| A remote URL smuggles a git option or a command transport | URLs are validated before `git remote add` or `set-url`: https, http, ssh, git, file, `user@host:path` or an absolute path. Nothing starting with `-`, and no `ext::`. |
| A tooltip link runs an arbitrary command | Tooltips can only run the extension's own commands, and text from a repository is inserted as plain text. |
| Running git in an untrusted folder | VS Code disables its Git extension in untrusted workspaces, and this extension depends on it, so it doesn't run there. |

## Check before push

Before every push, automatic or by hand, the extension looks at what the push would send: the lines added since the last commit, the files git doesn't track yet, and the commits that are on no remote (including those made from the terminal). It holds back:

| Rule | What it looks for |
|---|---|
| Environment file | `.env`, `.env.*`, `*.env`, except names with `example`, `sample`, `template`, `dist` or `default` |
| SSH private key | `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` (not `.pub`) |
| Key or certificate store | `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ppk` |
| Credentials file | `.netrc`, `_netrc`, `.git-credentials`, `.pgpass`, `.pypirc`, `.htpasswd`, `.dockercfg`, `credentials.json`, `client_secret*.json`, `*service-account*.json`, `secrets.json`/`.yml`/`.toml`, `.aws/credentials` |
| Terraform state | `*.tfstate`, `*.tfstate.backup` |
| Password database | `*.kdbx`, `*.kdb`, `*.agilekeychain`, `*.1pif` |
| Private key | a `-----BEGIN … PRIVATE KEY-----` block |
| Tokens and keys | GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), GitLab (`glpat-`), npm (`npm_`), Slack (`xox…-`), AWS access keys (`AKIA`, `ASIA`), Google API keys (`AIza`), OpenAI, Anthropic, Stripe live keys (`sk_live_`, `rk_live_`) |
| URL with a password | `scheme://user:password@host` |
| Big file | larger than `apus.maxFileSize` (50 MB by default; GitHub rejects anything over 100 MB) |

It only reports formats it can recognize with confidence, because a check that cries wolf gets ignored. Placeholders (`example`, `your…`, `xxxxxx`, `${VAR}`, `<token>`, `***`) don't count. An auto-commit with a finding pushes nothing and says why; a push by hand asks, and the answer is yours. Every finding and every "push anyway" goes to the log, without the secret itself.

The fake secrets in this repository's tests are assembled at runtime, so the source has none written down.

## Credentials

- **Never displayed.** Remote URLs are shown as `github.com/user/repo`, without user, password or token.
- **Masked in the log and in notifications.** apus prints the remote URL as it is configured; if it carries `user:token@`, the extension replaces it with `***@` before storing or showing that output. The same applies to git error messages.
- **Never requested in the background.** Auto-commits run with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` and `SSH_ASKPASS_REQUIRE=never`: no terminal prompt, no Git Credential Manager window and no SSH passphrase dialog can pop up while you work. A push by hand can still show Git Credential Manager, as any push would.
- **Not echoed back.** When you change a URL that carries credentials, the input box starts empty instead of showing the old one.

## Known limits

- **It recognizes formats, not intentions.** A password in a config file with no known format isn't caught. Keep [secret scanning and push protection](https://docs.github.com/code-security/secret-scanning) on for your GitHub repositories as well.
- **It can't take back what was already pushed.** If a secret reached a remote, change the secret; removing it from the history doesn't make it safe again.
- **apus on its own doesn't run the check yet.** Pushing from apus's window or from the terminal goes straight to `git push`.
- **Huge changes are checked in part.** More than 500 unpushed commits, diffs over 16 MB, files over 2 MB or more than 5000 files to read: what fits is checked, and the log says the check was partial.
- **Binary files are only checked by name and size**, not by content.
