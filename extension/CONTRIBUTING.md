# Contributing

Thanks for taking the time. Bug reports, ideas and pull requests are all welcome, in English or Spanish.

- **Found a bug?** Open an issue with the *Bug report* form. The version, your OS and what the **apus** output channel says (**Apus: Show Log**) save a lot of back and forth.
- **Found a security problem?** Don't open an issue: follow [SECURITY.md](SECURITY.md).
- **Want to change something bigger** than a fix? Open an issue first, so we can agree on the approach before you spend time on it.

## Setting up

You need Node.js 22, git, and VS Code 1.90 or later. apus is optional for most work; the integration tests push for real only when `APUS_EXE` points to it.

```bash
npm install
npm test
```

Press **F5** to open a VS Code window with the extension loaded from source. The rest of the scripts, and a map of the source, are in the [Development](README.md#development) section of the README.

## Before opening a pull request

CI runs all of this on Linux, Windows and macOS, so running it locally first saves a round trip:

```bash
npm run check          # types
npm run lint
npm run format:check   # or npm run format to fix it
npm run test:coverage  # fails under 90% of lines in src/core
```

And check that:

- **New behavior has a test.** Logic that doesn't need VS Code goes in `src/core/`, which must not import `vscode`, with unit tests in `test/unit/`. Flows that do need it can get a step in `test/integration/`.
- **Every text the user sees is translated.** Write it in English through `vscode.l10n.t(...)`, run `npm run l10n`, and add the Spanish translation to `l10n/bundle.l10n.es.json`. A unit test fails if one is missing. Texts in `package.json` go in `package.nls.json` and `package.nls.es.json`.
- **`CHANGELOG.md` says what changed** for users, under `## Unreleased`.
- **No real-looking secrets in tests.** Build fake tokens from pieces at runtime, like `test/unit/safety.test.ts` does, so neither the check before push nor GitHub's push protection trips on the repository.

## Conventions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `ci:`, `build:`, `style:`. The description can be in English or Spanish.
- Code comments are in Spanish, like the rest of the codebase. Comments in English are fine too: explain *why*, not *what*.
- Prettier decides the formatting. Commits that only reformat go in `.git-blame-ignore-revs`.

## Releases

Maintainers only: move the `## Unreleased` notes under `## X.Y.Z - YYYY-MM-DD`, bump `version` in `package.json`, then push a `vX.Y.Z` tag. The release workflow runs the tests, attaches the `.vsix` to a GitHub Release with those notes, and publishes to the Marketplace and Open VSX when their tokens are set.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
