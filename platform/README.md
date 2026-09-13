# xsphere

Private development integration, version 0.1. The long-lived `product/xsphere`
branch of `Axpz/agent-sandbox` is the single engineering portal: source, builds,
runtime delivery, deployment, verification and records start here. It is not an upstream
agent-sandbox release or a production-readiness claim.

## Naming and Ownership

| Name | Responsibility | Source |
| --- | --- | --- |
| xsphere | Product, deployment configuration and verification records | This directory |
| sandbox-api | E2B-compatible lifecycle API backed by Kubernetes resources | [sandbox-api/](sandbox-api/) |
| agent-sandbox-controller | Reconcile Sandbox, Claim, Template and WarmPool | Existing repository-root code and [Helm chart](../helm/) |
| sandbox-router | Forward requests to the selected Sandbox | Existing [Go Router](../sandbox-router/) |
| sandbox-edge | Adapt SDK headers and wildcard hostnames to Router headers | [Deployment chart](deploy/chart/) |
| runsc + shim | Sandbox isolation and optional memory restore | Locked upstream source + local patch + [delivery CLI](runtime/) |

`agentsphere-gateway` was the old repository name. The process, package, ownership
labels and Kubernetes Service were already named `sandbox-api`, so that name stays.
No API route, SDK field or `AGENTSPHERE_*` environment variable is renamed.

## Local Checks

Requirements: Bun 1.3.5, Helm 3.16.4 and Python 3.11+.
Docker is optional for the image target. Run from the repository root:

```sh
make -C platform install
make -C platform check
make -C platform render
make -C platform image
make -C platform runtime ARGS='--help'
```

`check` runs lint, TypeScript checking, offline contract/configuration/chart tests,
and a Bun build, plus runtime and image-discovery regression tests. It does not
contact Kubernetes. `render` prints product manifests; `controller-render` uses
the existing root controller chart. Runtime node edits are separate CLI commands
requiring explicit acknowledgement; they never restart a service. Helm may warn about the
permissions of `/dev/null`, used as its offline kubeconfig; no credential file is read.

The default dev profile uses locally built images, keeps all Services ClusterIP,
and leaves existing Templates/WarmPools untouched. See [deployment](docs/deployment.md)
before installing anything. Put environment-specific values under `platform/local/`
(gitignored), not in the shared defaults.

`controller-build`, `router-build`, `controller-image`, `router-image` and `images`
reuse existing source and Dockerfiles through the same Make entry. The root image
scanner skips `platform/`; the root Docker context excludes it so local plans,
dependencies and fetched sources do not enter upstream builds. `smoke-images`
tests already-available API and Nginx images without cluster access or public ports.

## Current Boundary

- The API's pause/resume preserves PVC data and recreates the Pod. It does **not**
  invoke gVisor checkpoint/restore. The separately tested memory workflow is
  documented in [lifecycle](docs/lifecycle.md).
- API-key enforcement and end-to-end data-plane authorization are not integrated.
  The chart refuses to render without explicit private-development opt-in. This
  acknowledgement is not an authentication or network-isolation mechanism.
- One namespace, one configured pool and trusted clients are the supported baseline.
  `templateID` is currently descriptive, not a multi-template routing table.
- No controller, node runtime or VM has been changed by this implementation work.
  Existing clusters and the original source working tree remain unchanged.

## Next Increments

1. Complete the pending image/build checks in the verification record, review an
   environment values file and deploy into an isolated test namespace;
   repeat SDK create/command/file/pause/resume/delete checks with the real image.
2. Integrate checkpoint coordination into the lifecycle owner: quiesce, save,
   verify artifact completion, then suspend; validate restore before resuming work.
   Keep Router independent of checkpoint logic.
3. Before exposing to untrusted clients, finish tenant authorization, safe metadata
   handling, data-plane credentials, TLS and network policy. Pin published image
   digests and define artifact retention and supported runtime combinations.

Detailed past evidence and exclusions live in [archive/](archive/). Those results
must not be reported as newly executed tests of this product chart.
The [initial product verification](archive/verification-20260913.md) records current
checks and deployment gates separately.
