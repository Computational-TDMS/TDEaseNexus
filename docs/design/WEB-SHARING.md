---
type: design
title: Web sharing (invitation-based)
description: LAN share of the live conversation mirror and read-only files through named invitations; hot revocation; hardening posture.
status: implemented
---

# Web sharing — invitation-based file view + collab chat

> Opt-in host server owned by Settings (`electron/share-server.ts`). The
> Backend itself is never exposed: the share server is the Desktop's own
> listener, and its authentication is independent of the Backend's per-launch
> bearer contract (`spec/WORKFLOW-RUN.md` §2).

## Invitations are the unit of identity

Guests are NAMED INVITATIONS (`sharing.invites[]`): each carries an id, a
host-chosen name, its own 24-byte token, its own tier (`collab` | `view`),
`createdAt` / `lastSeenAt` / `revokedAt`. The invitation — not a shared secret
— is the unit of identity, capability and revocation.

Login matches the presented secret against LIVE invitations (constant-time
compare); the session cookie binds to one invitation, and every request
re-resolves it. Revocation is therefore **hot**: killing an invitation ends
that guest's cookie AND their open SSE stream, without restarting the listener
and without touching other guests. Only a port/mode/workspaceId change
restarts the server.

## Surfaces

- `/collab` — live AI-conversation mirror: SSE replay of the session log plus
  live turn events (the same `RuntimeEvent` stream the host Renderer
  consumes). Guest prompts are prefixed `[guest: Name]`, so the host transcript
  shows who is speaking.
- `/files` — the read-only file view. `view`-tier invitations watch only.

Mirrored sessions are exactly the `notifySessionBound` registrations —
subagent children bound internally are NOT mirrored (the lazy-registration
leak is closed).

## Hardening posture

Per-peer failed-login throttle (doubling penalty, 30 s cap), async file reads,
Origin-checked POSTs (CSRF second line), and a Settings UI state that says
plainly that LAN sharing is plaintext HTTP (no TLS). LAN TLS is a declared
non-goal for now.

## Settings UI

Invitation manager: create → the token is shown exactly once and redacted
thereafter (explicit re-copy) → two-step revoke. A named audit trail records
login / prompt / denied / revoked. Legacy single-token configs migrate on read
to one "Link" invitation; enabling sharing with no invitations seeds one.

## Not built (open items)

Control tier (guest mutates nothing beyond prompts is the current ceiling —
prompts are the one guest input), per-guest identities beyond host-chosen
names, LAN TLS, per-session share opt-in UI for subagents.

## Alternatives considered

- **One shared token for everyone** (the original design) — lost: revocation
  was all-or-nothing and unattributed; the audit trail could not say WHO
  prompted, and removing one guest meant cutting every guest.
- **Real per-guest accounts** — declined: the host is a desktop app, not an
  identity provider; host-chosen names over invitation tokens give attribution
  and revocability without a credential lifecycle to own.
