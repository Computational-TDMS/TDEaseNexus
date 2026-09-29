# TDEase Desktop

TDEase is a desktop scientific workspace built from three independent products.

## Repository layout

```text
TDEase-zero/
├─ TDEase-FrontEnd/        Desktop UI, Electron host and Agent experience
├─ tdease-ai-capability/   Submodule: Agent Skills + Rust scientific system
├─ tdease-backend/         Submodule: Python/FastAPI service
├─ data/                   Local development runtime data
├─ docs/                   Product contracts, design and current status
└─ tests/                  Root contract/E2E suite (backend + skills)
```

Dependency direction:

```text
Desktop -> Backend -> Scientific System
Desktop ------------> Scientific System
```

- Desktop owns UX, Sessions, permissions, visualization and process supervision.
- Backend owns Run lifecycle, execution, storage, synchronization and server policy.
- Scientific System owns community Skills, scientific assets and Rust computation.

## Checkout

```bash
git clone --recurse-submodules https://github.com/Tisen-Ray/TDEaseNexus.git
```

For an existing checkout:

```bash
git submodule update --init --recursive
```

Read [docs/README.md](docs/README.md) for documentation ownership and
[docs/STATUS.md](docs/STATUS.md) for the implemented state.

## License

Licensed under the GNU General Public License v3.0 — see [LICENSE](LICENSE).
