# Imported Evidence

These are sanitized summaries of existing local records, not new test results.
The original repositories, files and dirty working trees have not been removed.
Absolute workstation paths, host addresses, credentials, kubeconfigs, memory dumps,
raw service logs and private business source are intentionally excluded.

## Source Inventory

| Original source | What is retained here |
| --- | --- |
| `agentsphere-gateway/src/` and build files | Source under `platform/sandbox-api/`, including pre-existing uncommitted changes |
| `agentsphere-gateway/deploy/k8s/` | Parameterized API/Router/Edge chart and optional generic runtime template |
| `agentsphere-gateway/MILESTONE_KIND_E2E_20260823.md` | ARM64 SDK/business milestone below |
| `agentsphere-gateway/ARCHITECTURE_STATUS.md` | Historical context; earlier than the completed milestone, not current readiness |
| `_demo/gvisor-cr/arm64-nopac.md`, `level2.md`, `kubectl-pause-resume.md` | Memory workflow boundary and runtime verification record |
| `_demo/gvisor-cr/restore-shim.md` and `restore-shim.patch` | Existing tracked source/build archive; gVisor stays an external dependency |

[import-manifest.json](import-manifest.json) records original source hashes and
the source commit. Hashes refer to pre-import bytes, not the modified destination.
Portability changes remove a workstation kubeconfig default, fail startup on an
explicit invalid kubeconfig, parameterize the Docker base, and make test tooling
explicit. Contract/backend behavior and ownership names remain unchanged.

Do not maintain both API copies going forward. Review and publish this baseline
first, then use `platform/sandbox-api` for further product development. Retiring the
old repository is a separate decision, not part of this import.

## Historical Milestones

**ARM business/SDK integration, completed 2026-08-24:** the prior ARM64 kind setup
recorded E2B SDK 2.1.5 and 3.0.0 create/connect/command/file/pause/resume/delete flows
and Codesphere UI/backend integration with envd, PostgreSQL, Redis and SeaweedFS.
This was PVC persistence and Pod recreation, not process-memory restoration. It
used private images, unauthenticated access and privileged FUSE; it was not an HA
or multi-tenant production deployment.

**gVisor memory validation, September 2026:** existing records describe same-node
single-container checkpoint/restore on AMD64 and ARM64 in a no-PAC Linux VM. ARM
records include 20 Sandboxes with five cycles each and cross-core affinity trials.
An ARM business-template probe recorded a stable token and 16 MiB heap hash across
restore. This is not proof of Apple Silicon support, GPU state, active FUSE mounts,
full application/LLM state or live network-connection continuity. Failed application
restore cleanup taking about two minutes remains a recorded limitation.

**Rebased shim source:** the retained gVisor fork branch compiled for AMD64/ARM64
and passed the recorded unit checks. It is a newer source base than the binaries
used in the Pod tests. Do not mix those two levels of verification; see the
[runtime lock record](../runtime/gvisor.lock.json).

## New Product Verification

`make -C platform check` is the reproducible offline entry for this import. It
covers API lifecycle contracts with a mocked Kubernetes client, fail-closed config
selection, Helm names/namespaces, private defaults, runtime opt-in, lint and build.
It does not rerun the historical milestones or change any live cluster.

The [initial verification record](verification-20260913.md) includes the ARM64 API
image smoke result and the checks still pending before deployment.

Before sharing this branch, review the new files and any existing untracked lab
material separately. Never stage the entire dirty worktree as an import shortcut.
