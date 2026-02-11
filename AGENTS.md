# Agent Workflow Notes

## Documentation Source Of Truth
- Treat `docs/cli-spec.md` as the canonical spec for behavior, security model, flags, defaults, and error semantics.
- Keep `README.md` concise and high-level; avoid duplicating large normative sections from the spec.
- Track execution state in `docs/work-tracker.md` using `Now`, `Next`, `Later`, and `Done`.

## Update Rules
- Any behavior change must update code and `docs/cli-spec.md` in the same commit.
- If product direction changes, update `docs/cli-spec.md` first, then implementation.
- Update `README.md` only for overview/onboarding/status changes.

## Iteration Hygiene
- At the end of each working session, update `docs/work-tracker.md` with remaining work and newly completed items.
- Keep checklist items short, concrete, and testable.
