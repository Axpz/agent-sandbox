# envd restore supervisor — 2026-09-29

A gVisor memory restore replays envd's saved image against a freshly built
netstack. Its netpoller is left waiting for an edge-triggered readiness
notification that is never delivered again, so `accept()` blocks forever while
the process still looks healthy: `/health` times out, the Pod never turns
Ready, and `POST /resume` fails. Upstream e2b never meets this because
Firecracker snapshots the whole VM, and the `examples/*-sandbox` templates
answer an unhealthy daemon with a container restart, which is unavailable here
— `restartPolicy: Never` is required by the checkpoint path, and restarting the
container would discard the restored process tree and make every resume a cold
start.

Only a fresh process image recovers envd, and everything in a restored sandbox
comes back from the checkpoint, so the postStart hook is the only code that
genuinely runs anew afterwards and therefore the only place the wedge can be
detected. The hook kills envd; a supervisor loop in the entrypoint starts the
replacement. This is the same arrangement upstream e2b gets from systemd's
`Restart=always` (`envd.service.tpl`), reduced to what a container image can
carry.

## Change

- `deploy/codesphere/runtime/entrypoint.sh` — `exec envd` became a supervisor
  loop. envd is now a child process, so killing it no longer ends the container.
- `deploy/codesphere/runtime/Dockerfile` — installs `tini` and runs it as the
  entrypoint. PID 1 is now a shell, which neither reaps orphans reliably nor
  forwards signals while blocked on a foreground child; `tini -g` does both.
  This also collects the orphan zombies envd-as-PID-1 was leaving behind
  (`[s3fs] <defunct>`).
- `deploy/codesphere/runtime/envd-recover.sh` — the postStart hook packaged in
  the runtime image.
- `deploy/chart/templates/runtime.yaml` — invokes that script through
  `lifecycle.postStart.exec`.

The verification below exercised the same script body when the chart inlined
it. Packaging it in the runtime image is a later delivery-only change and was
not deployed separately for this record.

The detection window is 15s. A restored envd never answers rather than
answering slowly, so the window only has to cover a cold start's bind time, and
every second of it is added to the resume latency that Edge's ensure-running
subrequest is waiting on.

envd's own source is deliberately untouched: patching it (self re-exec on a
signal, or rebuilding the listener) would carry a permanent fork of
`e2b-dev/infra`, which is pinned by version and commit.

## Deployment

- Image `codesphere-runtime@sha256:eb7e8ede373f6754eacac73487a108d6d0a48b60bfdd967fc8dee7cfb3245531`,
  built from `deploy/codesphere/runtime/Dockerfile` on the 55 host.
- `nexus.service.consul:5000` is unreachable from 55, so its base image was
  supplied from the local mirror by tagging
  `codesphere/pi-base:48-private-test-20260928` to the `FROM` reference for the
  build and removing that alias afterwards. Picking the other local mirror
  (`agentsphere-codesphere-pi-base:e2b-provisioned-20260708a`) produces an
  image 91MB smaller than the live one and was rejected for that reason — the
  base must be verified by size against the running image, not assumed.
- `kind load docker-image`, then a `ctr images tag` of the imported digest to
  `codesphere-runtime@sha256:...`. The checkpoint path validates that the
  runtime image is pinned by digest, so a tag reference is rejected at sandbox
  creation.
- The live `sandbox/xsphere-runtime-template` was patched with `--type=json` on
  the image and `lifecycle` paths only. A merge patch would replace the whole
  `containers` array; CRDs have no strategic merge. The two probes on that
  template belong to a separate work line and were left alone.

## Verification

Driven through the product path on the 55 kind cluster: `POST /sandboxes`,
`/pause`, `/resume` against `sandbox-api`.

| Check | Result |
| --- | --- |
| Cold start topology | PID 1 `tini`, PID 2 entrypoint loop, envd its child, Jupyter reparented to tini |
| Cold start readiness | Pod Ready in 7s; hook took the healthy path and killed nothing |
| Supervisor replaces envd | `pkill -x envd` → new envd under the same loop, `/health` 204 within 3s, container `restartCount` 0, Pod stayed Ready |
| Pause | 204 in 7.6s, checkpoint committed |
| Resume, no connections | 201 in 7.5s, restore annotation present, Ready, `/health` 204 |
| Resume, 5 held external TCP connections to envd | 201 in 8.1s, same result |
| Hook failure branch, envd unavailable | Detected at 15s, issued the kill, waited 15s more, logged, exited 0 — 32s total, bounded |

`restartCount` staying 0 is the load-bearing result: the recovery replaces envd
without restarting the container, so a restored process tree survives it.

## Observations and limits

**The wedge did not reproduce.** Both resumes restored a working envd, with and
without live external connections at checkpoint time, so the failure is not
deterministic and its trigger is still unknown. The hook's failure branch was
therefore exercised in a controlled way instead — the supervisor loop was
frozen so envd could not come back, and the deployed script was run against
that. This verifies detection, the kill, the bound and the exit status, but not
an end-to-end recovery from a naturally occurring wedge. That remains
unverified.

In a real wedge the loop is not frozen, so the hook should return in about 17s
(15s detection plus the replacement's bind), putting a wedged resume near 25s
end to end — far inside both `sandbox-api`'s 120s create timeout and Edge's 60s
ensure-running read timeout.

A separate defect in `sandbox-api/src/checkpoint/lifecycle.ts`, owned by
another work line, permanently locks a journal whose `'start'` stage times out,
which is what turned one occurrence of this wedge into a sandbox that could not
be resumed again (`ic466e261aa14`, still `Failed`). That is the step which
escalates an intermittent wedge into a lost sandbox; this change only removes
the wedge.

No unit or end-to-end test suites were run. Shell syntax was checked and the
chart renders. `xsphere-warmpool-74jdt` still runs an intermediate build of
this image under a live claim and was left undisturbed.
