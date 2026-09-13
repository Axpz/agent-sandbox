# xsphere Product Boundary

This directory contains downstream xsphere integration, not an upstream Kubernetes
component. Follow the repository-root AGENTS.md as well as these constraints.

- Product: `xsphere`. Control-plane component: `sandbox-api`. Keep existing
  API paths, SDK fields, environment variable names, labels used for ownership,
  Service names, and the `sandbox-edge` / `sandbox-router` routing contract.
- Use `make -C platform check` for offline verification. Go controller and Router
  source remains in the repository root; do not copy it here or replace its tooling.
- Deployment is opt-in. Do not change a cluster, replace node runtimes, create a
  VM, or rotate/delete PVCs as part of a documentation or source import task.
- The API currently implements PVC-preserving Pod recreation, NOT memory restore.
  Do not describe it as checkpoint-based pause/resume until it is integrated.
- Unauthenticated development deployment must be explicitly acknowledged. Do not
  remove this guard to imply production readiness. Do not expose the stack publicly.
- `runtime/` is a documentation-only entry for the external `Axpz/gvisor` repository.
  Pin source commits and distinguish build/unit evidence from Pod restore evidence.
  Do not duplicate gVisor patches, build tools or node installers in this repository.
- Link historical runtime verification records without importing binaries, memory
  dumps, kubeconfigs, tokens, raw customer logs or machine-specific values.
- Historical evidence belongs in `archive/`. Keep operational instructions in
  `docs/` current and clearly distinguish historical results from new tests.
- Keep source imports traceable in `archive/import-manifest.json`. Preserve the
  original source working tree; no blanket `git add`, deletion or history rewrite.
