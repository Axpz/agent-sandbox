# Sandbox Monitoring

[agent-sandbox-startup.json](agent-sandbox-startup.json) is the reusable source for
the existing Grafana dashboard, UID `agent-sandbox-startup`. It changes dashboard
queries only; it does not deploy exporters or change sandbox lifecycle behavior.

## Install or Update

Requires Prometheus scraping controller metrics, kubelet/cAdvisor,
kube-state-metrics and node-exporter. The dashboard expects a Prometheus
datasource UID of `prometheus`; adjust the JSON if your datasource UID differs.

1. Export the existing dashboard JSON as a backup.
2. In Grafana, use **Dashboards > New > Import** and upload this JSON. Keep its UID
   to update the existing dashboard without changing bookmarked URLs.
3. Select the resource namespace. Its default is `sandbox`.
4. Check resource rows against live Sandbox-owned Pods. Missing metrics must not
   be interpreted as zero resource use.

No Grafana restart is required. Export intentional UI edits back to this file;
do not store credentials or environment-specific exports in the repository.
The chart does not automatically install this dashboard.

## Measurement Boundaries

- **First startup:** controller-observed Claim to first Ready, split into cold
  creation and warm-pool adoption. This is not API latency or memory restore time.
  Summary averages use `increase` over the selected dashboard time range; trends
  use the rate interval. No observations means no average, not zero milliseconds.
  Sparse counters can miss an initial event before their first scrape; extrapolated
  increases are estimates, not an exact operation audit.
  The heatmap keeps zero-valued timestamps to size sparse cells, but does not
  color zero values. Filtering those timestamps in PromQL can hide a single
  observed event. The no-events guard uses the whole selected range at `end()`,
  so it hides an empty heatmap without dropping individual zero timestamps.
  Narrow the time range to inspect sparse samples.
- **Filters:** startup and inventory use the template selector. Existing startup
  metrics lack workload namespace labels, so identical template names aggregate
  across namespaces. Pod resources use a separate, single namespace selector and
  include all templates in that namespace.
- **Inventory:** not-ready and unexpired includes suspended, starting and failed
  Sandboxes. It must not be labeled as a paused count. Pool ownership overlaps
  readiness categories; the series should not be added together.
- **Resources:** use Pod-root cgroups, identified by empty `container`, `image`
  and `name` labels, joined to `kube_pod_owner{owner_kind="Sandbox"}`. Filtering by
  `container="runtime"` misses gVisor; counting both parent and child cgroups
  double-counts it. Snapshot Jobs, API, Edge and Router are excluded. Working set
  is not process heap size or checkpoint size. CPU is measured in cores.
- **Storage:** Pod I/O is cumulative bytes for the current Pod, resetting on
  recreation; it is not disk occupancy. The node filesystem panel shows the
  entire partition at `/var/local-path-provisioner`, not PVC or checkpoint usage.
  Adapt that mount point outside the current kind environment.
- **History:** a restored same-name Pod appears on the same memory series, with
  missing samples left as gaps. Missing samples alone cannot prove suspension.

## Pause and Resume Requests

Sandbox API exposes `/metrics` on a separate internal port, 9090 (`METRICS_PORT`
outside Helm). It is not routed through the business API or Edge. With Prometheus
Operator installed, enable `api.serviceMonitor.enabled=true` in the product chart;
set `api.serviceMonitor.labels` if your Prometheus selects monitors by label.
Restrict network access to the metrics port to trusted monitoring clients.

The standard [Prometheus client](https://github.com/prometheus/client_js) exports
`sandbox_api_lifecycle_request_duration_seconds`: its `_count` gives request
counts and `_sum / _count` gives average duration. Labels are bounded:
`operation=pause|resume|connect`, `result=success|client_error|server_error`.
Success means 2xx, client errors mean 4xx and server errors mean 5xx. No Sandbox
names, UIDs, raw paths or errors become labels. Error details remain in API logs.

The API panels use the resource/API namespace selector, not the template selector.
They count completed HTTP requests, including retries; `connect` includes a
connection to an already running Sandbox, so it is shown separately from resume.
They do not count background auto-pause, unfinished requests or reconstruct older
requests before instrumentation. Counts reset on API restart; Prometheus `increase`
handles observed resets, but events before the first scrape or after the last
scrape before a restart can be missed. Known series start at zero.
Request counts are displayed rounded to whole numbers and marked as estimates;
this presentation does not turn sampled metrics into an exact audit log.

Artifact sizes and per-stage timings are intentionally not added. The existing
controller cold/warm startup metrics retain their original measurement boundary.

## Verification

On 2026-09-14, two disposable Sandboxes on the private ARM64 kind installation
produced one real cold startup and one warm-pool adoption. Both were checkpointed
and restored with new Pod UIDs, the recorded restore paths and unchanged PVCs:
two successful pause requests, one explicit resume and one connect-based restore.
Prometheus observed both startup counter increments and all four lifecycle requests.
The tests did not inject metrics or change existing claimed Sandboxes.

A follow-up serial run the same day completed five cold starts and five warm-pool
adoptions, each followed by pause, explicit resume and deletion. Prometheus counter
deltas were exactly 5 cold, 5 warm, 10 pause and 10 resume. All ten restored Pods
used the recorded checkpoint paths and unchanged PVCs. Browser checks confirmed
visible heatmap cells at 1-hour and 48-hour ranges, including a sparse single-event
window; an event-free window displayed `No data` rather than an invalid legend.

Test Sandboxes and their PVCs were cleaned up after collection; checkpoint files
were retained under the existing artifact policy. The installation currently keeps
Prometheus data for 15 days on a PVC. Tests cover the normal path, not throughput
or failure recovery; request error classification is checked in offline tests.
