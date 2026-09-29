# Bootstrapping the Full Stack

How to bring up everything that makes a sandbox usable, in the order the layers
depend on each other: node prerequisites, the agent-sandbox controller, the
xsphere sandbox stack, an application with its backing services, monitoring, and
access from a browser.

[deployment.md](deployment.md) covers the xsphere chart alone and stays the
reference for that layer. This document is the surrounding context: what has to
exist under the chart, what sits on top of it, and which values have to agree
across files. It describes a private development installation. Nothing here is
hardened for a shared or public cluster.

Each layer states its prerequisites, the commands, and **how it fails when
skipped** — most of these failures are silent or misleading, which is the reason
the document exists.

## Contents

- [Layer 0 — Node prerequisites](#layer-0--node-prerequisites)
- [Layer 1 — The agent-sandbox controller](#layer-1--the-agent-sandbox-controller)
- [Layer 2 — The xsphere sandbox stack](#layer-2--the-xsphere-sandbox-stack)
- [Layer 3 — Application and backing services](#layer-3--application-and-backing-services)
- [Layer 4 — Monitoring](#layer-4--monitoring)
- [Layer 5 — Access](#layer-5--access)
- [Environment knobs](#environment-knobs)
- [Validated reference environment](#validated-reference-environment)
- [Known drift](#known-drift)

## Layer 0 — Node prerequisites

### Architecture

**amd64**, if memory-level pause/resume is wanted. gVisor checkpoint/restore does
not work on arm64. A filesystem-only sandbox stack runs on either; leave
`api.checkpoint` unset there and the rest of this section does not apply.

### Cluster

A single-node kind cluster is enough and is what the reference environment uses.
Two consequences of kind shape everything below:

- The node is a **container**. Every path in `api.checkpoint` — the runsc binary,
  `runscRoot`, `artifactRoot` — is resolved inside that container, not on the
  host. Reading them on the host finds nothing and proves nothing.
- Only the ports declared in the kind config reach the host. A NodePort is
  reachable at the **node container's** address, so from the host it needs a
  forward; see [Layer 5](#layer-5--access).

### Getting images into the cluster

`sandbox-api` rejects a mutable tag in a sandbox image reference, because a
memory checkpoint records the image it was taken from. So the runtime image needs
an `@sha256:` reference even when it never went through a registry:

```sh
kind load docker-image codesphere-runtime:your-tag --name YOUR_KIND_CLUSTER
docker exec YOUR_KIND_CLUSTER-control-plane \
  ctr -n k8s.io images ls name~=codesphere-runtime
docker exec YOUR_KIND_CLUSTER-control-plane \
  ctr -n k8s.io images tag codesphere-runtime:your-tag \
    codesphere-runtime@sha256:THE_DIGEST_FROM_THE_PREVIOUS_COMMAND
```

That digest is the locally loaded manifest's, which differs from what a
`docker push` would compute — docker-save/kind-load and a registry push encode
the manifest differently. A plain-HTTP host registry is not a shortcut:
containerd's default client refuses it.

*Skipped:* sandbox creation fails with a 500 from the API's own request schema,
not a pull error.

### gVisor

Install runsc and register two RuntimeClasses — `gvisor` → handler `runsc` for
ordinary sandboxing, and `gvisor-l2` → handler `runsc-l2` for the
checkpoint/restore path, which needs a shim built from the pinned fork. Source
commit, build steps and node integration are in the
[external runtime reference](../runtime/README.md); they are not repeated here.

Two containerd settings are easy to miss:

- The `runsc-l2` handler must allow the restore annotations:
  `pod_annotations = ["dev.gvisor.internal.*"]`. *Skipped:* restore silently
  ignores the recorded host image path and boots a fresh sandbox instead of
  resuming memory.
- `artifactRoot` must already exist on the node; nothing creates it. Give it a
  real disk — memory images are large.

### DNS for sandbox hostnames

Sandbox URLs are `<id>.<domain>` and `<port>-<id>.<domain>`, so whatever resolves
`domain` has to cover the wildcard. With an in-cluster domain and no real zone, a
CoreDNS rewrite does it — the reference environment uses this rule in
`kube-system/coredns`:

```
rewrite name regex ^[0-9]+-[^.]+\.sandbox-edge\.sandbox\.svc\.cluster\.local\.$ sandbox-edge.sandbox.svc.cluster.local. answer auto
```

*Skipped:* the API is healthy and sandboxes reach Ready, but every request to a
sandbox port fails to resolve.

## Layer 1 — The agent-sandbox controller

Install the [upstream chart](../../helm/), not the xsphere chart, and only one
controller per cluster. Extensions must be on — `SandboxClaim` is what the SDK
creates.

```sh
helm upgrade --install agent-sandbox helm/ \
  -n agent-sandbox-system --create-namespace \
  --set controller.extensions=true \
  --set image.tag=v0.5.4 \
  --set metrics.serviceMonitor.enabled=true
```

Those three settings are the entire user-supplied values of the reference
environment. `metrics.serviceMonitor.enabled` needs Prometheus Operator CRDs to
already exist, so install [Layer 4](#layer-4--monitoring) first or add it on the
next upgrade. The chart also has `metrics.prometheusRule.enabled` for a starter
alert rule.

Verify: the controller Pod is Ready and the core and extension CRDs are
established.

*Skipped or installed without extensions:* `SandboxClaim` objects are accepted by
the API server and never reconciled.

## Layer 2 — The xsphere sandbox stack

Build the API and Router images, load them, then install the chart with a values
file for the environment.

```sh
make -C xsphere image API_IMAGE=sandbox-api:xsphere-dev
kind load docker-image sandbox-api:xsphere-dev --name YOUR_KIND_CLUSTER
```

Copy a starting values file to `xsphere/local/` (gitignored) and fill it in:
[`deploy/values-dev.yaml`](../deploy/values-dev.yaml) for the chart layer alone,
or
[`deploy/codesphere/xsphere-values.example.yaml`](../deploy/codesphere/xsphere-values.example.yaml)
for the profile that pairs with [Layer 3](#layer-3--application-and-backing-services).
Then:

```sh
helm upgrade --install xsphere xsphere/deploy/chart \
  -n sandbox --create-namespace -f xsphere/local/values.yaml --wait --timeout 5m
```

Use `helm upgrade --install` on a new cluster. The reference environment was
applied with `helm template | kubectl apply`, which leaves the resources carrying
Helm labels while `helm list` reports no release — a state worth not reproducing.
Resource names are fixed (`sandbox-api`, `sandbox-router`, `sandbox-edge`, …), so
one release per namespace.

Verify: `sandbox-api`, `sandbox-router` and `sandbox-edge` Ready; the
SandboxTemplate and SandboxWarmPool exist; a warm pool member reaches Ready.

With `api.checkpoint` set, prove the restore path once before building on it:
create a sandbox, pause it, resume it, and confirm the new Pod has a different
UID, the same PVC, and a restore path under `artifactRoot`.

## Layer 3 — Application and backing services

The manifests in [`deploy/codesphere/`](../deploy/codesphere/) are a worked
example of an application driving sandboxes: Postgres, Redis and MinIO, a schema
migration, and a backend plus frontend. The images are private builds; supply
your own.

Order matters, and three of the four steps fail informatively only if the
previous one is complete:

```sh
# 1. Credentials and cluster-specific values. Copy, fill in, then apply.
cp xsphere/deploy/codesphere/codesphere-env.example.yaml /tmp/codesphere-env.yaml
$EDITOR /tmp/codesphere-env.yaml
kubectl apply -f /tmp/codesphere-env.yaml

# 2. Backing services. Wait for all three to be Ready.
kubectl apply -f xsphere/deploy/codesphere/infra.yaml
kubectl -n infra rollout status sts/postgres
kubectl -n infra wait --for=condition=complete job/codesphere-storage-init

# 3. Schema. Must be the same image as the backend.
kubectl apply -f xsphere/deploy/codesphere/migrate.yaml
kubectl -n codesphere wait --for=condition=complete job/codesphere-migrate

# 4. Application.
kubectl apply -f xsphere/deploy/codesphere/app.yaml
kubectl -n codesphere rollout status deploy/codesphere-backend
```

Do not keep a filled-in copy of the env file in the repository.

These manifests describe a fresh installation. Applying them over an existing one
that pinned a StorageClass is rejected outright — a bound PVC's spec and a
StatefulSet's `volumeClaimTemplates` are both immutable — so migrate an existing
deployment deliberately rather than by re-apply.

*Step 1 skipped:* the backend and the migration Job sit in
`CreateContainerConfigError` — the ConfigMap and Secret are consumed through
`envFrom`, so a missing one blocks container creation outright.
*Step 3 skipped:* the backend starts and its readiness probe never passes against
an empty schema. Re-running it after an image change needs
`kubectl delete job -n codesphere codesphere-migrate` first, because a Job's spec
is immutable.

## Layer 4 — Monitoring

Install kube-prometheus-stack from
[`deploy/monitoring/values-kube-prometheus-stack.example.yaml`](../deploy/monitoring/values-kube-prometheus-stack.example.yaml),
then turn on the xsphere side:

```yaml
monitoring:
  dashboards:
    enabled: true
api:
  serviceMonitor:
    enabled: true
router:
  serviceMonitor:
    enabled: true
```

The xsphere chart installs no Grafana, no Prometheus and no exporters — it ships
dashboard ConfigMaps and ServiceMonitors, which do nothing on their own. Two
settings in the example values are load-bearing and both fail quietly:
`serviceMonitorSelectorNilUsesHelmValues: false` (otherwise Prometheus only
selects monitors carrying its own release label, and every panel is empty) and
the sidecar's `folderAnnotation` (otherwise the dashboards land in Grafana's root
instead of the `xsphere` folder). [`deploy/monitoring/README.md`](../deploy/monitoring/README.md)
covers what the dashboards do and do not measure.

The control-plane dashboard's alert table reads `ALERTS` and stays empty until
some rule is installed; the controller chart's
`metrics.prometheusRule.enabled` provides a starter. An empty table is not a
statement about the stack's health.

Verify: the `sandbox-api`, `sandbox-router` and controller targets are `up` in
Prometheus, and the four dashboards appear in Grafana's `xsphere` folder.

## Layer 5 — Access

Keep all of this on localhost. No Ingress, LoadBalancer or DNS record is created,
and the unauthenticated baseline must not be exposed.

For the validated 55 environment, use the measured addresses, tunnel and
certificate pin in [access-55.md](access-55.md). The commands below remain the
portable pattern for other hosts.

**Grafana and the application frontend** go through `kubectl port-forward`. For a
remote cluster, forward on the cluster host and tunnel in:

```sh
# on the cluster host
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 13000:80
# on the workstation
ssh -N -L 3000:127.0.0.1:13000 YOUR_HOST
```

Read the Grafana admin password from the cluster when you need it; do not write
it into a file, a document or a chat log:

```sh
kubectl -n monitoring get secret kube-prometheus-stack-grafana \
  -o jsonpath='{.data.admin-password}' | base64 -d
```

**A NodePort on kind** listens on the node container's address, not the host's, so
a host-side `ssh -L` must target that address:

```sh
ssh -N -L 127.0.0.1:18443:NODE_CONTAINER_IP:30443 \
       -L 127.0.0.1:18080:NODE_CONTAINER_IP:30080 YOUR_HOST
```

`docker inspect` on the node container gives the address; `kubectl get nodes -o wide`
shows the same value as `INTERNAL-IP`.

**Sandbox hostnames in a browser** are the awkward part: they are in-cluster names
under a wildcard domain, served by Edge with a certificate the browser does not
trust. Map the wildcard to the tunnel and accept that certificate explicitly —
in a throwaway browser profile, never the daily one:

```sh
chromium \
  --user-data-dir=/tmp/sandbox-profile \
  --host-resolver-rules="MAP *.YOUR_DOMAIN:443 127.0.0.1:18443, MAP *.YOUR_DOMAIN:80 127.0.0.1:18080" \
  --ignore-certificate-errors-spki-list=BASE64_SPKI_OF_YOUR_CERT
```

The SPKI pin is narrower than disabling certificate errors wholesale. Derive it
from the certificate you created for `domain`:

```sh
openssl x509 -in tls.crt -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary \
  | base64
```

The certificate itself, if you are generating a self-signed one:

```sh
openssl req -x509 -nodes -newkey rsa:2048 -keyout tls.key -out tls.crt \
  -days 3650 -subj "/CN=*.YOUR_DOMAIN" \
  -addext "subjectAltName=DNS:*.YOUR_DOMAIN"
kubectl -n sandbox create secret tls sandbox-edge-tls --cert=tls.crt --key=tls.key
```

Edge needs TLS because the SDK requires https once `AGENTSPHERE_DEBUG` is false
and offers no scheme override. A self-signed certificate then also requires
`AGENTSPHERE_VERIFY_SSL=false` on the client side, or a CA bundle mounted into it
— see [Known drift](#known-drift).

## Environment knobs

Everything that has to be changed per cluster, and how a wrong value shows up.
Values that must agree across files are the common source of a stack that looks
healthy and does not work.

| Knob | Where | Must agree with | Symptom when wrong |
| --- | --- | --- | --- |
| `domain` | chart values | `AGENTSPHERE_DOMAIN` in `codesphere-env` | Sandboxes reach Ready; every sandbox URL fails to resolve |
| wildcard DNS for `domain` | CoreDNS Corefile, or a real zone | `domain` | Apex resolves, `<port>-<id>.<domain>` does not |
| `nodeSelector` hostname | chart values | `api.checkpoint.nodeName` | Restore is refused by the guard, or resumes on the wrong node |
| `api.checkpoint.runscBinary` / `runscSha256` | chart values | the runsc actually installed on the node | Restore rejected after a runtime upgrade changes the binary |
| `api.checkpoint.artifactRoot` | chart values | a directory that exists on the node | Checkpoint Jobs fail on a missing path |
| `api.checkpoint.workerImage` | chart values | a digest, not a tag | Worker drifts under a saved memory image |
| `runtime.image` | chart values | a digest reference | Sandbox creation returns 500 from the request schema |
| `runtime.templateName` | chart values | `AGENTSPHERE_TEMPLATE_NAME` | Surfaces only when the first sandbox is requested |
| `runtime.workspace.mountPath` | chart values | the application's own persistent path, if it has one | An application that expects a persistent working directory silently gets an ephemeral one |
| `api.warmPool` | chart values | the SandboxWarmPool in the same namespace | Every start is a cold start; no cross-namespace lookup |
| `AGENTSPHERE_API_URL` | `codesphere-env` | the `sandbox-api` Service and its namespace | Application cannot create sandboxes at all |
| `AGENTSPHERE_VERIFY_SSL` | `codesphere-env` | whether Edge's certificate is CA-trusted | TLS verification failures on every sandbox call |
| `WS_PUBLIC_URL` | `codesphere-env` | an address the **browser** can reach | Page loads, live session never connects |
| `AWS_S3_BUCKET` | `codesphere-env` | the bucket `infra.yaml` creates | First upload fails, long after deployment looks healthy |
| `DATABASE_URL` / `REDIS_URL` | `codesphere-runtime` Secret | passwords in `infra-credentials` Secret | Backend crash-loops on authentication |
| backend image | `app.yaml` and `migrate.yaml` | each other | Schema migrated to a different head than the code expects |
| Grafana datasource UID | monitoring values | `prometheus`, as referenced by the dashboard JSON | Dashboards load; every panel errors |
| `serviceMonitorSelectorNilUsesHelmValues` | monitoring values | must be `false` | Targets never scraped; all panels empty |
| StorageClass | omitted throughout | the cluster default, or set explicitly | PVCs stay Pending |

## Validated reference environment

The installation these instructions were written against, recorded as versions,
tags, digests and checksums. Host addresses, credentials and kubeconfigs are
deliberately excluded, as elsewhere in this repository.

| Layer | Recorded |
| --- | --- |
| Cluster | kind v0.33.0, Kubernetes v1.37.0, containerd 2.3.4, Debian 13 (trixie), kernel 6.17.0 amd64; one control-plane node, `agent-sandbox-control-plane` |
| Runtime | RuntimeClasses `gvisor` → `runsc` and `gvisor-l2` → `runsc-l2`; runsc at `/var/local/gvisor-cr/runtime/current/runsc`, sha256 `048b89aada69dc3333422e139d6e9d02f8ab06bda52398060e0fbdacca00074c`; shim `/var/lib/gvisor-ckpt/runtime-l2/containerd-shim-runsc-v1`; `artifactRoot` `/var/lib/gvisor-ckpt/checkpoints` on a dedicated 878 GiB filesystem |
| Controller | chart `agent-sandbox-0.1.0`, image `registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.4`, `controller.extensions=true`, `metrics.serviceMonitor.enabled=true` |
| xsphere | chart 0.2.0; `sandbox-api:connect-wait-20260929`, `sandbox-router:xsphere-dev`, Edge nginx 1.27.0; template `xsphere-runtime-template`, pool `xsphere-warmpool`; runtime image `codesphere-runtime@sha256:3be45182…`; checkpoint worker `sandbox-api@sha256:eaef002e…`; Edge TLS on with a self-signed wildcard certificate |
| Application | backend `codesphere/backend:206-20260923-1c68ce4f`, frontend `codesphere/frontend:206-20260921-kind55`; Postgres 16.8, Redis 7-alpine, MinIO `RELEASE.2025-09-07T16-13-09Z`, mc `RELEASE.2025-08-13T08-35-41Z` |
| Monitoring | kube-prometheus-stack 89.2.2, Prometheus Operator v0.93.1, 15-day retention; ServiceMonitors for the controller, `sandbox-api` and `sandbox-router`; four dashboards in the Grafana `xsphere` folder; etcd, controller-manager, scheduler, kube-proxy and Alertmanager disabled |

## Known drift

Where the reference environment differs from what these files describe. Listed
rather than folded into the manifests: some of it is a temporary fix, some is a
defect, and none of it should be reproduced silently.

- **The application images are private builds.** `YOUR_CODESPHERE_BACKEND_IMAGE`
  and `YOUR_CODESPHERE_FRONTEND_IMAGE` cannot be filled in from this repository.
  Everything else in the stack builds from source here.
- **A hotfix ConfigMap overrides application source.**
  `codesphere-backend-hotfix` is mounted over a single backend file to add
  path-style addressing for MinIO. It is deliberately not in `app.yaml`: the fix
  belongs in the image, and the mount is lost — correctly — the next time the
  image is rebuilt.
- **Two mechanisms for the self-signed certificate are active at once.** Besides
  `AGENTSPHERE_VERIFY_SSL=false`, the backend also mounts a
  `sandbox-edge-ca-bundle` Secret and sets `SSL_CERT_FILE`. Either approach works
  alone; `app.yaml` carries only the first, which is why `SSL_CERT_FILE` is absent
  from it. Mounting a CA bundle is the better of the two if the certificate is
  available at deploy time.
- **The application names a template that does not exist.**
  `AGENTSPHERE_TEMPLATE_NAME` there is `codesphere-pi-private-test-55`, while the
  only SandboxTemplate in the cluster is `xsphere-runtime-template`. It works
  because the API serves the warm pool regardless of the requested template, so
  the mismatch produces no error — and no error would appear either if the
  intended template genuinely differed from the one being used.
- **The workspace volume is unused by this application.** Its project directory
  (`AGENTSPHERE_PROJECTS_BASE_DIR`) sits outside the template's `/data` mount,
  and both that volume and the backend's own PVC are empty; project and user
  state lives in the MinIO bucket instead. So the per-sandbox 10 GiB PVC costs
  storage and buys nothing here. This is worth knowing before sizing a warm pool,
  and worth leaving alone otherwise: the path is not a persistence mechanism, and
  moving it onto the workspace volume would change the filesystem under it — a 9p
  gofer mount under gVisor — for an integration that currently works.
- **The xsphere stack there is not a Helm release.** It was applied with
  `helm template | kubectl apply`, so the objects carry Helm labels that no
  release owns. Helm cannot adopt them without an explicit migration.
- **The frontend Service is a NodePort there**, while `app.yaml` ships a
  ClusterIP. The NodePort has no host-side listener on kind anyway; access goes
  through a forward either way.
- **Edge pulls nginx from a host-local registry** because Docker Hub is
  unreachable from that host. The committed manifests use upstream references;
  mirror-prefix them where the network requires it.
