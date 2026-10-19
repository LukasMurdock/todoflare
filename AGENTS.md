# Repository guidance

## Vendored XState reference

`repos/xstate/` contains the XState source tree corresponding to the versions
installed by this application.

When working with XState:

- Treat `repos/xstate/` as read-only reference material.
- Do not edit files under `repos/xstate/` unless explicitly asked to update the
  vendored repository.
- Do not import application code from `repos/xstate/`; import from `xstate` and
  `@xstate/react` normally.
- Prefer the vendored implementation and tests over guesses or isolated web
  snippets.
- For machine and actor behavior, inspect `repos/xstate/packages/core/src/` and
  `repos/xstate/packages/core/test/`.
- For React integration, inspect `repos/xstate/packages/xstate-react/src/` and
  `repos/xstate/packages/xstate-react/test/`.
- Use examples only after confirming that their APIs match the installed and
  vendored package versions.
- Follow the project conventions in `agent-patterns/xstate.md` when introducing
  or changing XState code.

## Keeping the reference synchronized

The installed package versions and vendored source revision must be updated
together. The current reference is the `xstate@5.33.3` tag, which contains
`xstate@5.33.3` and `@xstate/react@6.1.0`.

Update it with:

```sh
git subtree pull \
  --prefix=repos/xstate \
  https://github.com/statelyai/xstate.git \
  'xstate@NEW_VERSION' \
  --squash
```
