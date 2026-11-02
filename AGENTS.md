# AGENTS.md

Guidance for AI agents (and humans) continuing development.

## Start here
1. Read `ROADMAP.md` — pick the first unchecked item in the lowest open milestone.
2. Read `docs/decisions/` — don't silently contradict an accepted decision; write a new ADR that supersedes it.
3. Read `docs/research/best-practices.md` for platform conventions.

## Working rules
- Small, focused commits; push after each meaningful step. Conventional commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
- Update `ROADMAP.md` checkboxes in the same commit as the work.
- Record any non-obvious decision as an ADR: `docs/decisions/NNNN-short-title.md` (Context / Decision / Consequences).
- Cross-platform first: shared logic lives in `packages/*`; platform-specific code uses `.web.tsx` / `.native.tsx` splits rather than runtime branching.
- Never commit secrets. Server config via Vercel env vars; see `.env.example`.

(Commands, layout and testing sections are filled in as the scaffold lands.)
