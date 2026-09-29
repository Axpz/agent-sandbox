# Sandbox Monitoring

## 面板速用（55 私有测试环境）

记住三步：**开隧道 → 打开面板 → 选范围**。
完整的 55 访问拓扑、联合隧道和证书处理见
[`docs/access-55.md`](../../docs/access-55.md)；这里仅保留 Grafana 面板的使用方法。

1. 本机终端运行 `ssh -N -L 3000:127.0.0.1:13000 55`，保持终端开着。
2. 浏览器打开 <http://127.0.0.1:3000/d/xsphere-sandbox-overview>，用 `admin` 登录
   Grafana；四块面板都在 Grafana 的 **xsphere** 文件夹下。
   密码在 55 上执行下面的命令获取，不要写进文档或聊天记录：

   ```sh
   kubectl -n monitoring get secret kube-prometheus-stack-grafana \
     -o jsonpath='{.data.admin-password}' | base64 -d
   ```

3. 「启动/存量模板」选 **All**，「沙箱命名空间」选 **sandbox**。总览与「快照与热池」
   默认最近 6 小时，「单沙箱下钻」与「控制面」默认最近 3 小时；看更久再往上调。

从总览开始看：流量行回答「现在有多少沙箱、这段时间创建了多少」，错误行回答
「失败在哪一层」，耗时行回答「慢在冷启动还是热池领取」。存量与资源行的表格里，
**点沙箱名可以跳到「单沙箱下钻」**，下钻面板的「沙箱」变量会自动带过去。控制器、
API、Router 的健康度看「控制面」；热池水位与快照成败看「快照与热池」。

冷启动是新建 Sandbox，热池领取是使用待命 Sandbox。最近没有创建请求时，当前速率
为 0，历史趋势仍可有数据。「窗口内无样本」表示该时间范围没有可计算的观测值；
**红色告警图标表示查询失败**，应检查 Grafana 的 Prometheus 数据源，而不是继续造
测试数据。热池抽空后领取会退化到冷启动量级，「池抽空累计时长」面板专门看这一点。

如果本机隧道连不上，先在 55 上确认 Grafana 转发还活着：

```sh
curl -sS http://127.0.0.1:13000/api/health
```

若没有返回健康状态，在 55 的另一个终端运行并保持：

```sh
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 13000:80
```

若提示 `13000: address already in use`，说明已有转发占用该端口；先检查它
是否健康，不要重复启动。浏览器只通过本机隧道访问，不对外暴露 Grafana。
重新部署 Grafana 13.2 distroless 时，保留 values 中的
`grafana.grafana.ini.plugins.preinstall_auto_update: false`，避免只读目录中的
Prometheus 插件更新失败。

## Dashboards

The dashboard sources live in
[`../chart/files/dashboards/`](../chart/files/dashboards/) and are delivered by the
product chart, not imported by hand. They change dashboard queries only; they
deploy no exporters and do not affect sandbox lifecycle behavior.

| File | UID | Rows |
| --- | --- | --- |
| `sandbox-overview.json` | `xsphere-sandbox-overview` | 流量 / 错误 / 耗时 / 存量与资源 |
| `sandbox-details.json` | `xsphere-sandbox-details` | 身份与状态 / 资源 |
| `control-plane.json` | `xsphere-control-plane` | 抓取目标 / 控制器 / Sandbox API / 控制面容器 / Sandbox Router / 节点运行时 |
| `snapshot-warmpool.json` | `xsphere-snapshot-warmpool` | 热池 / 快照 Job / 内存生命周期请求 / 快照存储 |

The earlier single dashboard, UID `agent-sandbox-startup`, is retired. Its panels
are folded into the overview, so bookmarks to `/d/agent-sandbox-startup` no longer
resolve. A hand-imported copy of it is not owned by the chart and is not reclaimed
by an upgrade; delete its ConfigMap explicitly once the new dashboards are visible.

## Install

Requires Prometheus scraping controller metrics, kubelet/cAdvisor,
kube-state-metrics and node-exporter, plus Prometheus Operator for the
ServiceMonitors. The dashboards expect a Prometheus datasource UID of
`prometheus`; adjust the JSON if your datasource UID differs.

For the monitoring stack itself, copy
[`values-kube-prometheus-stack.example.yaml`](values-kube-prometheus-stack.example.yaml)
— it carries the settings the dashboards depend on, with the reason for each,
and the kind-specific trims. Install it before the product chart, or the
dashboard ConfigMaps and ServiceMonitors have nothing watching them.

Then, in the values file for the target environment:

```yaml
monitoring:
  dashboards:
    enabled: true
    # Grafana folder; the sidecar must be configured to honour the annotation.
    folder: xsphere
api:
  serviceMonitor:
    enabled: true
router:
  serviceMonitor:
    enabled: true
```

Then install as described in [deployment](../../docs/deployment.md). The chart
renders one ConfigMap per JSON file into the release namespace, labelled
`grafana_dashboard: "1"` and annotated `grafana_folder`. A Grafana sidecar
watching that label — kube-prometheus-stack ships one — picks the dashboards up
without a Grafana restart.

The folder annotation only takes effect if the sidecar is told to read it —
`grafana.sidecar.dashboards.folderAnnotation` plus
`provider.foldersFromFilesStructure`, both set in the example values above.
Without them the dashboards still load, but land in Grafana's root alongside the
stack's own dashboards. Enabling them does not move existing dashboards: the
stack's own carry no `grafana_folder` annotation and stay put.

The ConfigMaps are the source of truth. Grafana will accept UI edits, but the
sidecar overwrites them on the next sync and an upgrade restores the file
contents, so make lasting changes in `files/dashboards/*.json`. Do not store
credentials or environment-specific exports in the repository.

The chart installs no Grafana, no Prometheus and no exporters. It also does not
enable the ServiceMonitors by default: set `api.serviceMonitor.labels` and
`router.serviceMonitor.labels` if your Prometheus selects monitors by label.
Restrict network access to the metrics ports to trusted monitoring clients.

The control-plane dashboard *displays* firing alerts but defines none, and this
chart ships no alerting rules. The controller chart has a starter rule behind
[`metrics.prometheusRule.enabled`](../../../helm/values.yaml); the panel is empty
until some rule is installed, which is not the same statement as the sandbox
stack being healthy.

## Measurement Boundaries

- **First startup:** controller-observed Claim to first Ready, split into cold
  creation and warm-pool adoption. This is not API latency or memory restore time.
  Summary averages use `increase` over the selected dashboard time range; trends
  use the rate interval. No observations means no average, not zero milliseconds.
  Sparse counters can miss an initial event before their first scrape; extrapolated
  increases are estimates, not an exact operation audit.
  Warm-pool adoption is reported as an average, a median and a count of adoptions
  slower than one second, deliberately without a P95: the histogram's smallest
  bucket is 100 ms, which is already above a healthy adoption, so a high quantile
  would report the bucket boundary rather than the latency.
  The heatmap keeps zero-valued timestamps to size sparse cells, but does not
  color zero values. Filtering those timestamps in PromQL can hide a single
  observed event. The no-events guard uses the whole selected range at `end()`,
  so it hides an empty heatmap without dropping individual zero timestamps.
  Narrow the time range to inspect sparse samples.
- **Filters:** startup latency uses the template selector only. Those histograms
  carry no workload namespace label, so identical template names aggregate across
  namespaces. Inventory (`agent_sandboxes`) and claim counts
  (`agent_sandbox_claim_creation_total`) do carry one, but under the name
  `exported_namespace`: Prometheus renames the series label because it collides
  with the target's own `namespace`, which holds the controller's namespace, not
  the sandbox's. Filtering those families on `namespace` silently matches the
  control plane instead of the workload.
- **Inventory:** not-ready and unexpired includes suspended, starting and failed
  Sandboxes. It must not be labeled as a paused count. Pool ownership overlaps
  readiness categories; the series should not be added together.
- **Resources:** use Pod-root cgroups, identified by empty `container`, `image`
  and `name` labels, joined to `kube_pod_owner{owner_kind="Sandbox"}`. Filtering by
  `container="runtime"` misses gVisor; counting both parent and child cgroups
  double-counts it. Snapshot Jobs, API, Edge and Router are excluded. Working set
  is not process heap size or checkpoint size. CPU is measured in cores.
  Sandbox Pods declare no resource limits, so the panels show absolute values with
  no utilisation percentage or limit reference line.
- **Storage:** Pod I/O is cumulative bytes for the current Pod, resetting on
  recreation; it is not disk occupancy. A restored Pod can be missing
  block-device counters entirely; an empty I/O value must not be read as zero I/O.
  The node filesystem panel shows the entire partition holding
  `/var/lib/gvisor-ckpt`, not per-checkpoint usage. Adapt that mount point outside
  the current kind environment.
- **History:** a restored same-name Pod appears on the same memory series, with
  missing samples left as gaps. Missing samples alone cannot prove suspension.

## Pause and Resume Requests

Sandbox API exposes `/metrics` on a separate internal port, 9090 (`METRICS_PORT`
outside Helm); Sandbox Router does the same. Neither is routed through the
business API or Edge.

The standard [Prometheus client](https://github.com/prometheus/client_js) exports
`sandbox_api_lifecycle_request_duration_seconds`: its `_count` gives request
counts and `_sum / _count` gives average duration. Labels are bounded:
`operation=pause|resume|connect`, `result=success|client_error|server_error`.
Success means 2xx, client errors mean 4xx and server errors mean 5xx. No Sandbox
names, UIDs, raw paths or errors become labels. Error details remain in API logs.

The API panels use the sandbox namespace selector, not the template selector.
They count completed HTTP requests, including retries; `connect` includes a
connection to an already running Sandbox, so it is shown separately from resume.
They do not count background auto-pause, unfinished requests or reconstruct older
requests before instrumentation. Counts reset on API restart; Prometheus `increase`
handles observed resets, but events before the first scrape or after the last
scrape before a restart can be missed. Known series start at zero.
Request counts are displayed rounded to whole numbers and marked as estimates;
this presentation does not turn sampled metrics into an exact audit log.

Per-stage checkpoint timings and artifact sizes are **not instrumented**, and
this revision deliberately keeps it that way: these dashboards are a presentation
layer over metrics the project already emits, and they change no Sandbox API or
Edge code. The snapshot panels therefore derive stage and duration from
`kube_job_*` — the stage comes from a
`label_replace` over the Job name suffix, and the duration is
`completion_time - start_time`, which includes Pod scheduling and image pull, not
just the checkpoint itself. The dashboard states these gaps in a panel of its own
rather than showing empty charts. The existing controller cold/warm startup
metrics retain their original measurement boundary.

## Known Blind Spots

These are absent by design or by dependency, not missing panels. Add them to a
review rather than rediscovering them each time.

- **Edge** is plain nginx with no `stub_status` endpoint, so it has no metrics
  target: no request rate, no status codes, no per-route latency. Adding an
  exporter would add a component to the telemetry stack. What *is* visible comes
  from kube-state-metrics — container resources, restart counts, probe failures,
  and the last termination reason with its exit code, which is enough to tell an
  OOM kill from a crash.
- **envd** inside the sandbox exports nothing; in-sandbox behavior is not visible
  to Prometheus.
- **A single sandbox cannot be correlated with its checkpoint Job.** Job names use
  the operation UUID, and labelling checkpoint metrics with a sandbox identifier
  would breach the cardinality rules in [AGENTS.md](../../../AGENTS.md). Use the
  API logs to tie an operation back to a sandbox.
- **Container termination reasons last only as long as the Pod object.**
  `kube_pod_container_status_terminated_reason` and its `last_terminated`
  counterpart are read off live Pods, so the two termination tables show nothing
  once a Pod is replaced or a finished checkpoint Job is garbage-collected. They
  are a "why did this one die" view, not a history; counts come from the restart
  counters instead. For checkpoint workers they give the Kubernetes-level cause
  (`Error`, `OOMKilled`, `DeadlineExceeded`) but not the API's own classification
  of the failure, which stays in the logs.
- **`sandbox_router_cert_reloads_total` is absent without TLS** on the router, so
  the dashboard carries no panel for it at all rather than a permanently empty one.
  Add one when the router terminates TLS.
- **Labelled router counters have no series until their first event.** Upstream
  errors, retries, cache invalidations and authz decisions only exist once the
  labelled combination has occurred. Retries and cache invalidations fall back to
  `vector(0)` so a steady state reads zero; upstream errors and the request-rate
  panel are left empty instead, because a fabricated zero there would be
  indistinguishable from a router that is not being scraped.
- **The `sandbox_template` sentinel differs between metric families**:
  `agent_sandboxes` uses `unknown` while the startup and claim metrics use
  `__unknown__`. Do not join families on `sandbox_template` without accounting
  for this.

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

On 2026-09-29, the four dashboards were checked against the live AMD64 kind
installation by extracting all 104 `expr` strings and querying Prometheus directly,
rather than by reading the rendered panels. No query returned an error. Four
returned an empty result, each a state the cluster did not hold at the time: no
expired Sandbox, no not-ready pool member, and no warm adoption inside the rate
window. The router target was confirmed `up` and its labelled counters
materialised under generated traffic; `cache_invalidations_total` and
`cert_reloads_total` stayed absent as documented above.

Three panels were added the same day from metrics already being collected, and
re-checked the same way: 58 queries across the two changed dashboards, no errors
and only the known not-ready-pool-member emptiness. The firing-alerts table was
checked against an installed controller rule, which stayed `inactive` while the
controller was up. The container termination table returned a real finding on
first use — the Edge nginx container's last termination was `OOMKilled` with exit
code 137 against its 128Mi limit — which is the failure mode that had no panel
before.

Test Sandboxes and their PVCs were cleaned up after collection; checkpoint files
were retained under the existing artifact policy. The installation currently keeps
Prometheus data for 15 days on a PVC. Tests cover the normal path, not throughput
or failure recovery; request error classification is checked in offline tests.
