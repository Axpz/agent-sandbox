# sandbox-api

The xsphere control-plane API. Imported from the existing `agentsphere-gateway`
working tree; source hashes are in [the import manifest](../archive/import-manifest.json).
The old repository is retained as a reference, not a second copy to maintain.

## Development

From the repository root:

```sh
make -C xsphere install
make -C xsphere check
```

To run against a deliberately selected development cluster, configure the values
shown in [.env.example](.env.example) through your shell or a local `.env`, then use
`make -C xsphere dev`. This starts a real API capable of changing that cluster;
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

Prometheus request metrics use a separate internal listener on port 9090
(`METRICS_PORT`), not the business API port. Keep it private. See
[monitoring](../deploy/monitoring/) for scraping and pause/resume measurement boundaries.

## Compatibility

The existing contract remains: create, get, list, delete, timeout, pause, resume and
connect under `/sandboxes` and `/v2/sandboxes`; `/health` and `/openapi.json` remain.
Wire fields retain their SDK casing, including `sandboxID`, `templateID` and
`autoPause`. Claims still carry `app.kubernetes.io/managed-by=sandbox-api` and
`sandbox-api/*` annotations. Clients continue connecting to Service `sandbox-api`.

The implementation defaults `autoPause` to true and create/resume JSON timeout to
7200 seconds. Without checkpoint configuration this remains the existing PVC
lifecycle. The opt-in memory lifecycle is described in
[lifecycle](../docs/lifecycle.md); it is deployed in the private single-node
installation. The normal memory path has been verified through the deployed business
Gateway/SDK; full chat/Pi session acceptance remains pending. Existing HTTP routes
and SDK fields are unchanged.

## Known Gaps

- `X-API-KEY` is documented, not enforced; the envd access token is a compatibility
  placeholder. A returned token or `secure` request is not proof of isolation.
- All template IDs select the configured pool. Reported CPU/memory/disk values are
  placeholders, not live resource accounting.
- Client metadata currently propagates to Pod annotations. Only trusted clients
  may use this baseline; privileged runtime annotations need an allowlist before
  multi-tenant access. `allow_internet_access` is not enforced by this API.
- Historical artifact deletion, request idempotency keys and per-tenant
  authorization are not implemented. A timed-out create may still
  finish in Kubernetes; do not blindly retry as though nothing was created.
- Mock tests confirm API behavior and failure handling, not real controller cleanup,
  PVC retention on deletion, network continuity or memory restoration.

Keep compatibility improvements separate from source import and deployment cleanup.
