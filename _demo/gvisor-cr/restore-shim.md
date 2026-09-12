# Experimental gVisor Restore Shim

This is a source archive of the tested [shim patch](restore-shim.patch), not a
production release or an agent-sandbox controller change. Apply it to gVisor,
not to this repository. It adapts the restore approach from google/gvisor#13326.

## Pinned Source

- gVisor tag: `release-20260817.0`
- gVisor commit: `50e1502a95d36ad2faf2c7ef33b8bf21fe975293`
- Patch SHA256: `0456119a36f7e40f75ac83b9f192b470cae15b9a32dfaa8e3d78a1f1ffe680b1`
- Recorded build tools: Bazel 8.3.1 and its generated Go 1.26.3 toolchain.

The patch changes three production shim files, one test file, and test build
dependencies. It reads `dev.gvisor.internal.restore.host-image-path`, validates
the checkpoint path, strips shim-only restore annotations from the OCI spec,
and dispatches the init task's Start request to the existing Restore operation.
Ordinary exec requests retain their normal behavior. Invalid checkpoints must
fail, not silently cold-start. A root restore failure transitions the task to
stopped so it can be deleted; a later application-restore failure still has the
cleanup limitation below.

`runsc` itself is the unchanged official binary for the pinned release and
architecture. Only `containerd-shim-runsc-v1` is rebuilt. No PAC fix is included.

## Build

Run from this repository on a Linux amd64 build host with Git, Make, Python 3,
a C/C++ toolchain, and Bazel 8.3.1 available. This uses a fresh checkout and
does not install binaries or modify a running node:

```bash
set -e
PATCH="$(pwd)/_demo/gvisor-cr/restore-shim.patch"
GVISOR_BUILD_DIR=$(mktemp -d /var/tmp/gvisor-restore-build.XXXXXX)
git clone --depth=1 --branch release-20260817.0 https://github.com/google/gvisor.git "$GVISOR_BUILD_DIR/src"
cd "$GVISOR_BUILD_DIR/src"
test "$(git rev-parse HEAD)" = 50e1502a95d36ad2faf2c7ef33b8bf21fe975293
git apply --check "$PATCH"
git apply "$PATCH"
git diff --check
make DOCKER_BUILD=false test TARGETS='//pkg/shim/v1/runsc:runsc_test //pkg/shim/v1/proc:proc_test' OPTIONS='-c opt --jobs=4'
mkdir -p "$GVISOR_BUILD_DIR/out"
make DOCKER_BUILD=false copy TARGETS=//shim:containerd-shim-runsc-v1 OPTIONS='-c opt --jobs=4' DESTINATION="$GVISOR_BUILD_DIR/out"
sha256sum "$GVISOR_BUILD_DIR/out/containerd-shim-runsc-v1"
```

For ARM64 cross-compilation on that amd64 host, install the AArch64 C/C++
cross-toolchain and use `OPTIONS='--config=aarch64 -c opt --jobs=4 --local_resources=memory=8192'`
in the copy step. To export ARM64 tests, invoke the same copy step separately
for `//pkg/shim/v1/runsc:runsc_test` and `//pkg/shim/v1/proc:proc_test`; run those
executables on ARM64. Do not execute ARM64 tests directly on the amd64 host.

Record source, patch, build options, and output checksums together. Build stamp
metadata can change binary checksums even with the same source. Keep the
matching official `runsc` release and architecture with the shim artifact.

## Verification And Limits

Recorded verification on 2026-09-11/12 includes both shim test targets on amd64,
both test targets repeated three times natively on ARM64, 100 ARM64
Sandbox pause/restore cycles, and one real ARM64 template/Claim restore through
envd SDK commands and files. These are historical results, not tests rerun by
archiving this patch. Snapshot artifacts and private test data are not included.

- ARM64 was tested in a Linux VM with PAC disabled, not as a fix for PAC-enabled
  hosts. Apple Silicon and GPU state restoration are not established.
- Scope is same-node, single application container, fixed runtime and image.
  Quiesce application writes before checkpoint, preserve the matching PVC, and
  use a fresh destination for each checkpoint. Memory snapshots do not roll
  back persistent or external storage.
- An incompatible application command is correctly rejected, but failed Pod
  cleanup can take about two minutes. This remains unresolved.
- The installed older agent-sandbox controller reports the wrong Claim
  `Ready.observedGeneration`. That separate controller fix is not in this patch.
- In the ARM test, kubectl port-forward could not reach envd; a restricted
  Kubernetes HTTP proxy worked. Active FUSE/S3 mounts, full LLM sessions, and
  external connection continuity were not tested.
- Host-image-path annotations require admission and ownership controls before
  allowing untrusted Pod authors. Protect checkpoint files as sensitive memory
  dumps. This patch alone is not a multi-tenant production deployment.

Names such as RuntimeClass `gvisor-l2` and containerd handler `runsc-l2` are node
integration choices, not source versions. Register the handler and annotation
allowlist before selecting it from a Pod; this archive does not change them.
