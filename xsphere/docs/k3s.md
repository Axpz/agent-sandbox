# K3s integration

The release entry is [`release.json`](../release.json). It pins the component
versions used together; an xsphere tag does not upgrade a cluster automatically.
Keep environment values, registry access and TLS keys in `xsphere/local/` or
existing Kubernetes Secrets.

## Components

| Namespace | Contents |
| --- | --- |
| `agent-sandbox-system` | Controller, sandbox-api, upstream Router and Edge |
| `sandbox` | Template, WarmPool, Claims, sandbox Pods/PVCs and checkpoint workers |
| `monitoring` | kube-prometheus-stack and dashboard ConfigMaps |

Install gVisor from its [own repository](../runtime/README.md); register the
`gvisor-x` RuntimeClass before selecting it in a Template. Provision the
`xsphere-lvm` StorageClass with upstream OpenEBS LVM CSI. Configure thin-pool
monitoring/extension on the node; the dashboard displays capacity but does not
extend a pool. Neither runtime installation nor storage setup is performed by
the xsphere chart.

Install matching Controller/CRDs and the **unmodified upstream Router chart**
separately, using the versions in the release manifest. The Router example is
[`values-router.example.yaml`](../deploy/values-router.example.yaml). Replace
the documentation-only `192.0.2.10/32` with the real API endpoint CIDR, including
any endpoint the Router actually uses. Sharing a namespace does not replace this
NetworkPolicy exception. Choose an accessible, verified Router image.

## Render the integration

Copy [`values-k3s.example.yaml`](../deploy/values-k3s.example.yaml) into
`xsphere/local/values-k3s.yaml` and select reachable images, domain and TLS Secret.
The workload and monitoring namespaces must already exist. Review the explicit
private-network/unauthenticated opt-in before installation; Edge provides routing
and automatic wake-up, not tenant authorization.

```sh
make -C xsphere install
make -C xsphere check
make -C xsphere render NAMESPACE=agent-sandbox-system VALUES=local/values-k3s.yaml
```

`workloadNamespace: sandbox` scopes API RBAC, its worker ServiceAccount and optional
Template/WarmPool to the workload namespace. Their RoleBindings reference the API
ServiceAccount in the management namespace. `router.enabled: false` leaves the
Router entirely to its upstream chart; Edge uses `sandbox-router-svc` in the
management namespace.

Memory pause/resume additionally requires `api.checkpoint` with the selected
node, runsc binary/hash/root, worker image and persistent artifact directory;
see [lifecycle](lifecycle.md). These machine-specific values are deliberately
absent from the example. Preserve the reviewed live configuration when preparing
an upgrade; the default without checkpoint configuration is file persistence.

The example reuses an existing workload Template and WarmPool. To create new ones,
review a local image-specific profile with `runtime.enabled: true`, its image,
workspace path and startup/recovery requirements. `runtime.warmPoolReplicas: 2`
only applies when runtime resources are enabled. Preserve existing PVCs and
checkpoints when reviewing adoption; rendering is not an ownership migration.

`domain` is the internal SDK domain. If public previews are needed, set
`edge.publicDomain` separately; `edge.blockedPublicPorts` preserves the existing
port restrictions. `edge.apiLookupHost` optionally exposes the private read-only
`GET /sandboxes/{id}` lookup. These virtual hosts are disabled unless configured.
TLS certificates must cover the selected SDK domain and already exist as a Secret.

## Monitoring

Use the upstream kube-prometheus-stack values in
[`deploy/monitoring/`](../deploy/monitoring/). Match Grafana's dashboard search
namespace to `monitoring.dashboards.namespace`. For an HTTPS proxy, set Grafana's
`server.root_url` to the browser-facing URL; retain authentication and existing
Secrets.

The overview's resource table shows **online/offline** and **warm pool yes/no**.
Management API metrics use the separate management-namespace selector; workload
counts and resource usage use the sandbox-namespace selector.
Online means Pod Ready. Offline includes retained `workspace-i…x` PVCs with no
Pod; resource gaps remain gaps. Deleted sandboxes with retained workspace PVCs
can remain in this inventory. Warm membership uses the current Pod label, not
its historical launch type. The supplied kube-state-metrics allowlist exports
only that label. Changes appear after scraping; these are monitoring observations,
not an authoritative API status.

OpenEBS thin-pool panels use existing LVM metrics. Snapshot filesystem panels
default to the node root partition; adapt the mountpoint if snapshots reside
elsewhere. Central log collection and external alert notifications are not
installed by this profile.
