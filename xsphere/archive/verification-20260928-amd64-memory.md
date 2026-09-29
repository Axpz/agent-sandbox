# AMD64 Memory Pause/Resume Verification: 2026-09-28

**Newly executed**, not an import. A second single-node kind cluster on an AMD64
host, because gVisor checkpoint/restore is usable there. The ARM64 installation
was not touched.

Deployed: the product chart (API, Router, Edge, Template, WarmPool) plus a
runtime image carrying only `envd`. No chat application, database or agent
credentials — none are needed for the sandbox lifecycle. The cluster's existing
upstream controller (`--extensions=true`) and gVisor RuntimeClasses were reused.
Delivery was `helm template` + `kubectl apply`; three images built locally for
AMD64 and loaded into the node, none pushed.

## Results

| Check | Result |
| --- | --- |
| Create from warm pool | 576 ms, Pod Ready |
| Edge → Router → envd `/health` | 204 |
| `POST /pause` | 204; Sandbox suspended; Pod removed |
| Checkpoint artifact | 15 MB under the artifact root |
| `POST /resume` | 201; Pod recreated |
| **Process survived** | `envd` elapsed continued 52 s → 69 s, not reset |
| **Memory, not volume** | A `/tmp` file (container layer, not the volume) survived |
| Edge → envd after resume | 204 |

The last two rows are the point: a volume-preserving recreation would have given
a fresh process and lost `/tmp`.

## Prerequisites this run surfaced

All are already satisfied on ARM64, whose template is hand-written and whose
runtime lives in a versioned directory — so none had been exercised before.

1. `restartPolicy: Never` on the runtime Pod. The memory path refuses a Pod the
   kubelet could restart in place. The chart did not render it; fixed in
   `deploy/chart/templates/runtime.yaml`.
2. The artifact root must exist on the node first. It is a `hostPath` with a type
   check, and a missing directory surfaces only as the Job deadline.
3. runsc must live in a directory of its own — the worker mounts its parent
   directory at the same path and would otherwise shadow the worker's own tooling.
4. The template must pin `kubernetes.io/hostname`; the restore guard compares it.
5. Locally loaded images need the manifest digest, not the builder's image ID.

## Existing failure-path behaviour, recorded not changed

- **A failed create leaves its claim behind**, holding a warm-pool sandbox. With
  the memory lifecycle enabled the claim has no shutdown time, so it does not
  expire. Three failed attempts here left one each.
- **A failed save keeps its operation record on purpose** (only a failed restore
  clears it): a partial snapshot warrants inspection, not a blind retry. To
  retry, remove the `operation` field from that sandbox's checkpoint ConfigMap.
  Deleting the ConfigMap itself does not work — it is the lifecycle record.

## Not covered

One cycle only; no large-memory sandbox, so the worker deadline was never
approached; no agent session; ARM64 left untouched.
