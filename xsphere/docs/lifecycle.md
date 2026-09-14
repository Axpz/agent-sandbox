# Two Different Pause/Resume Workflows

Both workflows retain a Kubernetes Sandbox identity, but only one preserves process
memory. Do not infer memory support from the name of an HTTP endpoint.

| Workflow | Pause | Resume | Preserved |
| --- | --- | --- | --- |
| Default sandbox-api | Request `operatingMode: Suspended`; wait for suspension | Request `Running`; wait for readiness | PVC data, not process memory |
| Separately verified gVisor flow | Quiesce application, checkpoint, verify completion, then suspend | Set restore annotation to completed artifact, request Running, release application hold | Process state plus unchanged business PVC, within tested compatibility limits |

## Memory Workflow Boundary

The controller still performs normal Pod deletion/recreation. The patched shim
interprets `dev.gvisor.internal.restore.host-image-path` during creation and asks
runsc to restore. Kubernetes and containerd source do not need to change for that
annotation path. The node's containerd annotation allowlist and runtime configuration
must already be installed.

Checkpoint artifacts (`checkpoint.img`, `pages.img`, `pages_meta.img`) are read and
written through a path in the **node runtime's mount namespace**, not merely a path
visible inside the business container. In kind, a host directory also needs to be
mounted into the node container. A business PVC mount inside a Pod does not by
itself provide the same host path to the shim.

For the initial supported setup, artifacts stay on the same node and each snapshot
uses a unique directory. Keep the business PVC, image, runtime build and CPU feature
configuration compatible. Cross-node transport, shared storage, S3 staging, disk
rollback and garbage collection are not implemented by this product baseline.

Quiesce writes before saving and leave them quiesced until the original Pod is gone.
Checkpoint captures state at a point in time; later writes do not become part of
that saved state. `sync` alone does not prevent future writes. Files may exist as
zero-byte placeholders before checkpoint: file count alone is not completion proof.
Wait for checkpoint acknowledgement and validate artifacts before suspension.

If saving fails, do not suspend or delete the running workload. If restore fails,
preserve the artifact and PVC and surface the failure; do not silently cold-start.
The old Pod is already gone after a successful pause, so keeping an original live
Pod available during failed resume is not a guarantee this flow can make.

## Opt-In API: Save Then Stop

The opt-in implementation under `sandbox-api/src/checkpoint/` is deployed in a
private, single-node ARM64 kind installation. An isolated API exercise completed
checkpoint, suspension and restoration to a Ready Pod. The existing business API
and template have since been upgraded in place; Codesphere and SDK calls are
unchanged. A subsequent exercise through the deployed Codesphere Gateway/SDK
completed create, envd command execution, pause, resume and deletion. An envd-started
probe retained its random process identity and the SHA-256 of 8 MiB of random memory:
its counter was 58 before saving, 58 after restoration, then advanced to 136.
The old Pod/runtime exited during pause and the same PVC was used for restore.
This verifies that normal path on the configured node, not the full Codesphere
chat/Pi session workflow. Pod readiness alone does not prove memory continuity.

With `AGENTSPHERE_CHECKPOINT_CONFIG` (chart value `api.checkpoint`) enabled, newly
created Claims use this path; existing unmarked Claims keep the default workflow.
It requires one API replica, one configured node, a pinned image/runtime, and a
single-container `restartPolicy: Never` Pod. Use a `Recreate` API Deployment so
old and new instances do not concurrently process the same operation journals.

1. `pause` runs native `runsc checkpoint` **without** `--leave-running`. gVisor
   saves memory and stops the sandbox itself; there is no separate external freeze,
   debug signal or unfreeze step.
2. After the worker reports a completed, checksummed artifact, the API records its
   path, requests `Suspended`, and waits for the controller to remove the old Pod.
   Pending Pod termination is not a successful pause. Do not force-delete the Pod
   object to make it appear complete.
3. `resume` and `connect` validate the recorded artifact, put its path in the
   restore annotation, request `Running`, and wait for the restored Pod to be Ready.

Artifacts live at `<artifactRoot>/<sandboxUID>/<operationUUID>/`. The record points
to the latest successful snapshot. A new save uses a new directory, never overwrites
the previous files, and replaces the recorded path only after success. Historical
file deletion and a latest-one/three retention policy are deliberately deferred.
The three files alone, especially zero-byte placeholders, are not a completion marker.

Important limitation: in the pinned runsc build, native checkpoint can stop the
original processes even when saving fails. The API retains the previous successful
artifact and PVC and reports failure; it cannot promise the old process is still
running. A failed or uncertain save is not retried automatically and may need operator
inspection. Restore failures never trigger a silent cold start.

The existing private ConfigMap records in-flight progress and the last successful
artifact. The existing API image runs short-lived node Jobs. `autoPause` uses the same
path, rather than controller expiry deleting a Pod before saving. No new CRD, daemon,
Codesphere change or Router change is part of this step.

Private journal version 2 rejects the earlier experimental version 1 workflow,
which left the runtime externally frozen. Do not upgrade an old experimental API
with unfinished operations into this version and expect automatic migration.
Before reusing its namespace, stop the old experimental API and archive its
discovery labels and records without deleting the artifacts or business PVCs.
Do not roll back to the PVC-only API after admitting memory-managed Claims: that
API cannot honor their checkpoint state.

Historical validation and exact runtime versions are recorded in [runtime/](../runtime/)
and [archive/](../archive/); they are not an assertion that every ARM machine,
kernel feature, active connection or business application can be restored.
