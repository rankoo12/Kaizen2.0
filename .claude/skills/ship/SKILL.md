---
name: ship
description: Verify a Kaizen change end-to-end before declaring it done — typecheck, lint, tests, a real code-path exercise, then a clean human commit with no AI attribution. Use when the user says /ship, "wrap this up", "commit and open a PR", or a change is ready to land. Reports verified-vs-assumed honestly.
---

# Ship

Nothing is "done" because it compiles. Prove the real path, then commit clean. Fixes here land in production.

## 1. Static gates
- `npm run typecheck` — must be clean.
- `npm run lint` — must be clean (fix it, don't suppress it).
- `npm run test` — full Jest suite green. If you added a capability, the new unit tests must exist and pass (per `docs/CLAUDE.md`: locate the module's `__tests__` and update it before finishing).

## 2. Exercise the real path
- Don't trust unit tests alone. Run the actual code path end-to-end against live infra: `docker info` first; if a run is involved, execute a test through the worker and confirm the step actually did what the change claims — check `step_results`, not just "no error thrown."
- Hit the edge cases for what changed: negative / empty input, the failure branch, the cache-warm repeat.

## 3. Commit (only when the user asked to commit)
- Branch naming: `type/scope/short-description`, kebab-case.
- Message format: `feat/fix/chore(scope) : "description"`.
- Plain first-person human voice. **No `Co-Authored-By: Claude`, no "Generated with Claude Code", no mention of Claude anywhere in the message or PR body.**
- Never commit `.env` or hardcoded secrets.

## 4. Report
State plainly what you **verified** (with the command output / step result) vs what you **assumed**. If a gate failed or a step was skipped, say so — don't round up to green.
