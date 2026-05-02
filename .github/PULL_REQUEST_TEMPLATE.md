# Summary

<!-- 1-3 bullets: what changes and why. Skip implementation details unless they're load-bearing. -->

-
-

## Linked issue

<!-- "Closes #123" auto-closes the issue on merge. Optional. -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor (no behavior change)
- [ ] Docs
- [ ] Test
- [ ] Chore (build, deps, tooling)

## Testing

<!-- What you ran. Be specific. -->

- [ ] `python3 -m pytest backend/tests/` — passing
- [ ] `cd ui && npx vitest run` — passing
- [ ] `cd ui && npm run build` — succeeds
- [ ] Manual UI smoke (describe below)

Notes:

## Screenshots

<!-- For UI changes. Before / after if visual; just after if it's a new view. -->

## Checklist

- [ ] `python3 -m ruff check .` clean
- [ ] `python3 -m ruff format --check .` clean
- [ ] `python3 -m mypy backend/` clean
- [ ] `npx tsc --noEmit` clean
- [ ] `npx eslint .` clean
- [ ] Tests added or updated for new behavior
- [ ] User-facing docs updated if needed (README, wizard text, env example)
- [ ] No `Co-Authored-By: Claude` (or any LLM attribution) in commit messages
