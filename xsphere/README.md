# xsphere

Private development integration, version 0.1. The long-lived `product/xsphere`
branch of `Axpz/agent-sandbox` is the single engineering portal: source, builds,
runtime references, deployment, verification and records start here. It is not an upstream
agent-sandbox release or a production-readiness claim.

## Naming and Ownership

| Name | Responsibility | Source |
| --- | --- | --- |
| xsphere | Product, deployment configuration and verification records | This directory |
| sandbox-api | E2B-compatible lifecycle API backed by Kubernetes resources | [sandbox-api/](sandbox-api/) |
| agent-sandbox-controller | Reconcile Sandbox, Claim, Template and WarmPool | Existing repository-root code and [Helm chart](../helm/) |
| sandbox-router | Forward requests to the selected Sandbox | Existing [Go Router](../sandbox-router/) |
| sandbox-edge | Adapt SDK headers and wildcard hostnames to Router headers | [Deployment chart](deploy/chart/) |
| runsc + shim | Sandbox isolation and optional memory restore | External `Axpz/gvisor` source; [pinned version and integration notes](runtime/) |

`agentsphere-gateway` was the old repository name. The process, package, ownership
labels and Kubernetes Service were already named `sandbox-api`, so that name stays.
No API route, SDK field or `AGENTSPHERE_*` environment variable is renamed.

gVisor source and patches are maintained in the external repository. This portal
links to a fixed commit and its verification limits; it does not duplicate runtime
build or installation tools.

## Local Checks

Requirements: Bun 1.3.5, Helm 3.16.4 and Python 3.11+.
Docker is optional for the image target. Run from the repository root:

```sh
make -C xsphere install
make -C xsphere check
make -C xsphere render
make -C xsphere image
```

`check` runs lint, TypeScript checking, offline contract/configuration/chart tests,
and a Bun build, plus image-discovery regression tests. It does not
contact Kubernetes. `render` prints product manifests; `controller-render` uses
the existing root controller chart. gVisor installation is a separate node operation,
not a product Make target or Helm action. Helm may warn about the
permissions of `/dev/null`, used as its offline kubeconfig; no credential file is read.

The default dev profile uses locally built images, keeps all Services ClusterIP,
and leaves existing Templates/WarmPools untouched. See [deployment](docs/deployment.md)
before installing anything. Put environment-specific values under `xsphere/local/`
(gitignored), not in the shared defaults.

The [monitoring dashboard](deploy/monitoring/) covers first startup, pause/resume
requests and Pod resources, with separate measurement boundaries and filters.

`controller-build`, `router-build`, `controller-image`, `router-image` and `images`
reuse existing source and Dockerfiles through the same Make entry. The root image
scanner skips `xsphere/`; the root Docker context excludes it so local configuration,
dependencies and build outputs do not enter upstream builds. `smoke-images`
tests already-available API and Nginx images without cluster access or public ports.

## Current Boundary

- The API's default pause/resume preserves PVC data and recreates the Pod. The
  opt-in memory lifecycle and separately tested manual runtime workflow are
  distinguished in [lifecycle](docs/lifecycle.md). The API save/stop path is deployed
  in the private installation. Its normal memory path has been verified
  through the deployed business Gateway/SDK; chat/Pi session acceptance remains pending.
- API-key enforcement and end-to-end data-plane authorization are not integrated.
  The chart refuses to render without explicit private-development opt-in. This
  acknowledgement is not an authentication or network-isolation mechanism.
- One namespace, one configured pool and trusted clients are the supported baseline.
  `templateID` is currently descriptive, not a multi-template routing table.
- No controller, node runtime or VM has been changed by this implementation work.
  The explicitly approved rollout updated the existing API and business template;
  previously claimed Sandboxes retain their original configuration and PVCs.

## Next Increments

1. After the completed Gateway/SDK memory check, jointly validate the actual chat/Pi
   session workflow. Do not substitute a `kubectl exec` background
   process for the business workload: gVisor kills exec-origin processes on restore.
2. Keep Router and Codesphere unchanged; artifact retention is a later small increment.
3. Before exposing to untrusted clients, finish tenant authorization, safe metadata
   handling, data-plane credentials, TLS and network policy. Pin published image
   digests and define artifact retention and supported runtime combinations.

Detailed past evidence and exclusions live in [archive/](archive/). Those results
must not be reported as newly executed tests of this product chart.
The [initial product verification](archive/verification-20260913.md) records current
checks and deployment gates separately.
