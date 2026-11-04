# Package distribution & update policy

Status: `design` (the `packages` skill ships with the installer; the public
index host is not yet deployed).

How every extension artifact of TDEase reaches a user's machine, and what may
update it afterwards. One rule organizes the whole document:

> **Install is an ownership transfer.** What ships with the app is ours to
> replace on every update. What the user installed into their workspace or
> catalog is theirs — we may tell them a newer version exists, we never
> overwrite their copy.

## The three update channels

| Artifact | Channel | Overwrite semantics |
|---|---|---|
| App, built-in viewers, system prompts/templates/skills | electron-updater (background check + blockmap differential download, user-decided restart; `electron/updater.ts`) | Replaced with every update — they live in the install directory |
| Node packages the user installed | None. Ever. | `tdease.nodes.install` refuses existing ids; the catalog seed extracts only into an empty catalog ("a user-managed catalog is never overwritten afterwards"). A newer index version is **information**, not an action |
| Skills the user installed (workspace `.tdease/skills/`) | None. Ever. | Workspace files are user-owned by product principle; no channel may touch them |

The physical line between "auto-updatable" and "never touched" is the
install-directory boundary: silent updates replace the install directory,
preserve the data root (`installer.nsh` `${IfNot} ${Silent}` guard), and never
enter the workspace.

## The marketplace: a static index, the agent as package manager

The marketplace is a static website whose primary consumer is the **agent**,
not a browser: humans get pages, the agent gets `index.json`.

```
https://<package-host>/
├── index.json
├── nodes/<id>/<version>/<id>-<version>.zip
├── skills/<id>/<version>/<id>-<version>.zip
└── (human-readable pages, optional)
```

No API, no accounts, no database, no in-app store UI. The same static host
serves the app's `latest.yml` update feed — one infrastructure, two feeds.

### index.json (schema v1)

```json
{
  "schemaVersion": 1,
  "updated": "2026-09-13T00:00:00Z",
  "packages": [
    {
      "kind": "node",
      "id": "toppic",
      "version": "1.8.1",
      "description": "TopPIC 1.8.1 top-down identification toolchain",
      "curation": "first-party",
      "url": "https://<host>/nodes/toppic/1.8.1/toppic-1.8.1.zip",
      "size": 104857600,
      "sha256": "…"
    }
  ]
}
```

- `kind` is `node` | `skill` today. Viewers are **absent on purpose**: they
  ship with the app (the L1 viewer contract, `viewerContract.ts`, keeps a
  future runtime-loading path open, but no third-party viewer channel exists
  until a real demand appears).
- `curation` labels provenance (`first-party` | `community`). Community node
  packages carry real binaries that cannot be code-audited; the label plus the
  displayed source is the v1 trust statement, user judgment is the control.
- `sha256` is a hard gate: the agent verifies the downloaded archive against
  it before any install step. A mismatch is a loud failure, never a skip.
- One id, one version per entry; updates append new versioned entries (the
  index is append-mostly and cache-friendly).

## The `packages` skill (the AI package manager)

A built-in skill (`tdease-ai-capability/system/skills/packages/`) owns the
whole flow and documents the index protocol:

1. **Discover** — fetch `index.json`, filter by user intent, present
   candidates with provenance (`curation`), size, and version.
2. **Fetch & verify** — download to workspace staging
   (`.tdease/packages/`), verify `sha256`, unpack.
3. **Install** —
   - node: `tdease.nodes.install` with the unpacked folder path (it copies
     into the LOCAL Backend catalog and enforces `rules.smk` presence, unique
     ids, residue filtering; under a remote `backendConnection` it reports
     that host's ownership boundary instead of installing);
   - skill: unpack into workspace `.tdease/skills/<id>/` — workspace-scoped,
     active on the next session, never system-wide.
4. **Inform, never overwrite** — when an installed node/skill differs from
   the index (older version, or local modifications detected against the
   install-time digest), report it and stop. An upgrade is an explicit,
   user-approved replacement (one node id holds one version; old Runs keep
   their provenance — definitions record the digest they executed, catalog
   edits are not retroactive).

Downloads and installs are permission-gated: the agent fetching and
installing executable content is the prompt-injection surface, and the
approval dock is the control point — `auto` authority does not bypass an
install approval.

Portable fetch/verify tooling (works on a clean machine per the packaged bash
runtime): `curl` (System32/MinGit), `sha256sum` (msys coreutils;
`certutil -hashfile <f> SHA256` as fallback), `tar -xf` (bsdtar reads zip).

## The release pipeline (two tracks, both human-gated)

### App track — tag-driven, one script, nothing else uploads

```
[human] bump package.json version
[human] scripts/release/publish-app.ps1
  ├─ gates: clean tree / version == tag-to-be / submodule pointers committed
  ├─ build: pnpm desktop:build (typecheck + quality gates + vendor + builder)
  ├─ upload: electron-builder publish (provider: github) → TDEaseNexus-Releases
  │          emits installer + latest.yml + blockmap automatically
  ├─ verify: anonymous curl of latest.yml (same loop the updater will run)
  └─ tag v{version} + push
```

"Only formal releases get uploaded" is implemented by making this script the
ONLY upload path: no CI auto-publish, no webhooks, no schedules. Dev builds
stay in the local `release/` directory; the human running the script IS the
decision. The feed repo must be public (a private release feed would require
embedding a token in the shipped installer). CI-based building can be added
after the product repo goes public — the tag trigger stays the same.

### Package track — live and verified

```
tar pack → sha256 → gh release create → index.json entry → push
```

### Version conventions

- `package.json` is the single source of the app version (semver); app tag
  `v{version}`; package tag `{id}-{version}`.
- Submodules version independently (backend 0.2.0, kernel 0.1.0); the app
  version freezes pointers, it does not version them.
- Cold-start rule: installers cut BEFORE the updater shipped (≤1.0.2) can
  never self-update; the first updater-bearing release is the baseline from
  which automatic updates work, existing users reinstall once manually.

## Roadmap

Archived at `archive/docs-prune-2026-10-12/docs/design/PACKAGE-DISTRIBUTION-archived-roadmap.md`
— the shipped-scope phases are done; STATUS.md owns current status.

## Alternatives considered

- **In-app store UI with accounts, ratings, one-click install.** Lost: the
  product's primary path is intent → Agent; the agent IS the package manager.
  A store duplicates it with a second, worse UI and an auth surface, for a
  user base of researchers who asked the agent in the first place.
- **Central registry API (search, versions, auth).** Lost: a static file on
  static hosting answers every query the agent needs; an API adds an operator,
  a domain to secure, and downtime dependency for zero new capability.
- **Auto-updating installed nodes/skills.** Lost: users fine-tune installed
  artifacts; any overwrite destroys their work. Ownership transfer beats
  freshness (decided with the product owner, 2026-09-13).
- **Per-package signing.** Lost: heavy to operate, meaningless before a real
  community exists; digest-in-index + one index signature covers the same
  attack for a fraction of the cost.
- **Distributing viewers separately from the app.** Lost: runtime loading of
  external components is a trust boundary the current demand does not justify;
  the L1 contract keeps the option open at near-zero cost.
