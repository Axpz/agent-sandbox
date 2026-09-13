# Private Development Deployment

This runbook is opt-in. It does not upgrade the existing installation. Start in a
new test namespace, using a disposable business workload, before planning adoption
of any current resources. Do not expose this unauthenticated baseline publicly.

## Prerequisites

- An existing Kubernetes cluster with the core and extension CRDs and a running
  agent-sandbox controller with extensions enabled. Manage it through the existing
  [upstream Helm chart](../../helm/), not the xsphere chart. Do not install a second
  controller or blindly apply different-version CRDs over the working cluster.
- A compatible Go Router image built from [the root Dockerfile](../../sandbox-router/Dockerfile).
  Its build context is the repository root. The dev values reference the historical
  ARM64 local image, not a public multi-architecture artifact.
- An API image built from this directory's source, loaded into kind or published
  to a reachable registry. API, Router and business image architecture must match
  the selected nodes. Helm rendering does not verify image availability.
- A Template/WarmPool in the target namespace, or an explicit `runtime.enabled=true`
  profile with a compatible envd image, workspace mount path and StorageClass.
- gVisor is optional. Selecting `runtime.runtimeClassName=gvisor-l2` requires that
  RuntimeClass and its node handler to already exist. It does not enable checkpointing.
  Source versions and manual node integration are documented in the
  [external runtime reference](../runtime/). This repository does not install gVisor
  or rename existing `gvisor-l2` deployments.

## Build and Render

From the repository root:

```sh
make -C xsphere install
make -C xsphere check
make -C xsphere image API_IMAGE=sandbox-api:xsphere-dev
make -C xsphere render NAMESPACE=xsphere-dev
make -C xsphere controller-render
```

For kind, load the newly built image only into the explicitly selected cluster:

```sh
kind load docker-image sandbox-api:xsphere-dev --name YOUR_KIND_CLUSTER
```

The API Dockerfile defaults to `oven/bun:1.3.5-slim`. A mirror can be chosen through
Docker's `--build-arg BUN_IMAGE=...`; no regional mirror is hard-coded into source.
Keep architecture and immutable digests in your release record when publishing.
`make -C xsphere images` builds API, controller and Router locally, without pushing
or loading them into a cluster. Existing controller/Router build targets and
Dockerfiles remain the implementation; there is no duplicate source tree.

With the API and Nginx images already available locally, run
`make -C xsphere smoke-images`. `API_IMAGE` and `EDGE_IMAGE` may select local
verification tags; `EDGE_PLATFORM` can explicitly select an available architecture
for a configuration-only check (it does not validate the other architecture).
This checks API health/OpenAPI and rendered Nginx configuration
in network-isolated test containers. It is not Kubernetes or SDK E2E coverage.

Create an environment-specific values file under `xsphere/local/`, based on
[values-dev.yaml](../deploy/values-dev.yaml). For example, a new namespace with an
unprivileged envd-compatible runtime could use:

```yaml
development:
  allowUnauthenticated: true
api:
  image: sandbox-api:xsphere-dev
  warmPool: codesphere-warmpool
router:
  image: YOUR_ROUTER_IMAGE
domain: sandbox.example.invalid
runtime:
  enabled: true
  image: YOUR_ENVD_RUNTIME_IMAGE
  warmPoolReplicas: 0
  workspace:
    mountPath: /workspace
    storageClass: standard
    size: 10Gi
```

Replace both image placeholders. Match `mountPath` to the application's persistent
data directory. With `runtime.enabled=false`, the API requires an existing pool in
the same namespace; it does not reach across namespaces. A zero-size warm pool
permits cold creation without maintaining idle Sandboxes.

The generic template intentionally has no privileged mode, `/dev/fuse` hostPath,
checkpoint annotations or shared checkpoint PVC. It is not a replacement for the
historical privileged Codesphere/FUSE template. Reuse that approved template for
existing business workloads until a separate security/profile review is completed.

## Install Only After Review

Run these manually after selecting context, namespace, images and values:

```sh
helm template xsphere xsphere/deploy/chart \
  --namespace xsphere-dev -f xsphere/local/values.yaml
helm upgrade --install xsphere xsphere/deploy/chart \
  --kube-context YOUR_CONTEXT --namespace xsphere-dev --create-namespace \
  -f xsphere/local/values.yaml --wait --timeout 5m
```

Keep API and Edge access private, such as localhost-only `kubectl port-forward`.
No Ingress, LoadBalancer or DNS records are created. Host routing needs the chosen
wildcard domain pointed at Edge; API traffic goes to the separate `sandbox-api`
Service, not the Edge data-plane listener.

Existing resource names are stable: `sandbox-api`, `sandbox-router`,
`sandbox-router-svc`, `sandbox-edge` and `sandbox-edge-nginx`. Consequently only one
release is supported per namespace. Helm cannot silently adopt the existing
kubectl-managed resources: do not use force/take-ownership or delete them to bypass
an ownership error. Review an explicit migration with exports and rollback first.
Uninstalling a release with owned Templates/WarmPools can affect dependent workloads;
it is not a harmless cleanup command.

Database, cache and S3 services are application dependencies, not sandbox-api
dependencies. The chart does not redeploy the existing PostgreSQL, Redis or SeaweedFS.

Values are grouped by component and validated for types and unsafe Nginx substitutions,
following the [Helm values guidance](https://helm.sh/docs/chart_best_practices/values/).
