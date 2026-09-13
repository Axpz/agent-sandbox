# Two Different Pause/Resume Workflows

Both workflows retain a Kubernetes Sandbox identity, but only one preserves process
memory. Do not infer memory support from the name of an HTTP endpoint.

| Workflow | Pause | Resume | Preserved |
| --- | --- | --- | --- |
| Current sandbox-api | Request `operatingMode: Suspended`; wait for suspension | Request `Running`; wait for readiness | PVC data, not process memory |
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

## Integration Still Required

The current API does not implement any of this checkpoint coordination. In
particular, its default `autoPause` expiry can stop a Pod without saving memory.
Keep memory-managed workloads outside that automatic lifecycle until integrated.

The next increment should add durable progress and retry behavior at the lifecycle
owner, with checkpoint completion as a prerequisite for suspension. Keep artifacts
immutable once complete and associate them with workload identity, image/runtime
versions and architecture. A failed request must not destroy the last usable
artifact. Do not put checkpoint logic into Router, which only forwards traffic.

Historical validation and exact runtime versions are recorded in [runtime/](../runtime/)
and [archive/](../archive/); they are not an assertion that every ARM machine,
kernel feature, active connection or business application can be restored.
