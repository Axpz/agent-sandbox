# sandbox-api

The xsphere control-plane API. Imported from the existing `agentsphere-gateway`
working tree; source hashes are in [the import manifest](../archive/import-manifest.json).
The old repository is retained as a reference, not a second copy to maintain.

## Development

From the repository root:

```sh
make -C platform install
make -C platform check
```

To run against a deliberately selected development cluster, configure the values
shown in [.env.example](.env.example) through your shell or a local `.env`, then use
`make -C platform dev`. This starts a real API capable of changing that cluster;
it is not needed for offline tests. Keep its listening port private.

Kubernetes configuration selection:

1. A nonempty `AGENTSPHERE_KUBECONFIG` is explicit. A missing or invalid file fails
   startup; it must not silently select another cluster.
2. Otherwise use client-node's normal discovery (`KUBECONFIG`, standard local
   configuration, or in-cluster ServiceAccount as applicable).

The previous machine-specific default file is removed. This is an intentional
portability change: local operators should explicitly choose a cluster. Only load
trusted kubeconfigs; they can include credential-execution plugins. See
[Kubernetes kubeconfig guidance](https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/).

`AGENTSPHERE_K8S_SKIP_TLS_VERIFY` stays false by default. Its legacy development
escape hatch disables process-wide certificate checks; never use it in production.

## Compatibility

The existing contract remains: create, get, list, delete, timeout, pause, resume and
connect under `/sandboxes` and `/v2/sandboxes`; `/health` and `/openapi.json` remain.
Wire fields retain their SDK casing, including `sandboxID`, `templateID` and
`autoPause`. Claims still carry `app.kubernetes.io/managed-by=sandbox-api` and
`sandbox-api/*` annotations. Clients continue connecting to Service `sandbox-api`.

The implementation defaults `autoPause` to true and create/resume JSON timeout to
7200 seconds. This is the existing PVC lifecycle, not memory checkpointing. Do not
use these leases to manage a memory-checkpoint Sandbox until coordination is integrated.

## Known Gaps

- `X-API-KEY` is documented, not enforced; the envd access token is a compatibility
  placeholder. A returned token or `secure` request is not proof of isolation.
- All template IDs select the configured pool. Reported CPU/memory/disk values are
  placeholders, not live resource accounting.
- Client metadata currently propagates to Pod annotations. Only trusted clients
  may use this baseline; privileged runtime annotations need an allowlist before
  multi-tenant access. `allow_internet_access` is not enforced by this API.
- There is no durable checkpoint job, restore preflight, artifact retention policy,
  request idempotency key or per-tenant authorization. A timed-out create may still
  finish in Kubernetes; do not blindly retry as though nothing was created.
- Mock tests confirm API behavior and failure handling, not real controller cleanup,
  PVC retention on deletion, network continuity or memory restoration.

Keep compatibility improvements separate from source import and deployment cleanup.
