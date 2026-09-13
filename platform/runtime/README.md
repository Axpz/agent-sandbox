# gVisor Delivery

This branch is the runtime delivery entry point: upstream source is pinned,
the patch is stored here, and downloads/builds/bundles/configuration all run through
`make -C platform runtime`. The separate Axpz/gvisor fork is useful for upstream
contributions, but is not required for these commands. No Git submodule or manually
maintained second checkout is required. Binaries and downloaded source are gitignored.

## Prepare and Build

Run from the repository root. Source preparation and packaging require Python 3.11+,
Git and curl. Compilation uses the historically verified Linux/amd64 build route
with Make, a C/C++ toolchain and Bazel 8.3.1. ARM64 output additionally requires
the AArch64 cross-toolchain. The script refuses to compile on macOS or to treat
an ARM64 host as an x86 build host; it does not install system packages or start a VM.

```sh
make -C platform runtime ARGS='--help'
make -C platform runtime ARGS='fetch-runsc --arch arm64 --output out/runsc-arm64'
make -C platform runtime ARGS='prepare --workdir out/gvisor-build'
make -C platform runtime ARGS='verify-source --workdir out/gvisor-build'
make -C platform runtime ARGS='build --workdir out/gvisor-build --arch arm64 --runsc out/runsc-arm64 --output out/runtime-arm64'
```

Use `amd64` throughout for an AMD64 bundle. `prepare --source /path/to/git/repo`
can use an existing local Git cache, but still fetches/verifies the locked commit
into a fresh directory. It never changes the source repository. Existing output
directories are refused instead of reset or deleted.

Build runs the existing shim/proc unit targets on Linux/amd64, exports the selected
architecture's shim, and packages it with the matching official runsc. ARM64 unit
execution and real Pod E2E remain promotion gates for a newly built ARM64 artifact.
Build stamps can change shim hashes; the bundle records actual checksums and source
provenance instead of pretending a rebuild has the historical binary hash.

To reuse the recorded binaries, without recompiling:

```sh
make -C platform runtime ARGS='bundle --arch arm64 --runsc /path/to/runsc --shim /path/to/containerd-shim-runsc-v1 --output out/runtime-arm64'
make -C platform runtime ARGS='verify-bundle --bundle out/runtime-arm64'
```

`bundle` accepts only the recorded official runsc and patched-shim hashes. The
bundle contains two ELF binaries, `runsc.toml` and a manifest. This is the tested
local-checkpoint/systrap profile, not every gVisor feature: metric-server and GCS
checkpoint sidecars are not packaged. Newer full gVisor releases require reviewing
the [upstream installation layout](https://gvisor.dev/docs/user_guide/install/),
not simply changing the version string in this two-binary profile.

## New Isolated kind Cluster

On the chosen **Linux** kind host, create a dedicated empty checkpoint directory,
then render configuration using an explicit node image and an unused cluster name:

```sh
make -s -C platform runtime ARGS='kind-render --bundle out/runtime-arm64 --checkpoint-dir /path/to/empty-checkpoints --name xsphere-lab --image kindest/node:v1.36.1' > platform/out/kind.json
```

JSON is valid YAML for kind. This mounts the immutable runtime bundle read-only
and the checkpoint directory at `/var/lib/xsphere/checkpoints` inside the node.
There are no public port mappings, controller installs or changes to an existing
cluster. Verify the image architecture and CPU features before proceeding.

Only after approval to create this isolated cluster:

```sh
kind create cluster --config platform/out/kind.json --kubeconfig platform/out/kubeconfig-xsphere-lab
```

The generated handler is `runsc-xsphere`. Render the node-scoped RuntimeClass:

```sh
make -s -C platform runtime ARGS='runtimeclass-render --node xsphere-lab-control-plane' > platform/out/runtimeclass.json
```

Review and activate it with an explicit kubectl context after checking CRI health,
then choose `gvisor-xsphere` in the reviewed business template. For the optional
chart template, set `runtime.runtimeClassName=gvisor-xsphere`.
**Never recreate the existing working cluster
to add a mount.** The root controller chart and product chart remain separate
releases, managed from this repository; see [deployment](../docs/deployment.md).

## Existing Linux Node

Do this only on the explicitly selected node, with Python 3.11+, containerd and
the bundle available there. For kind, the node is the node container, not the VM's
host containerd. Do not run the installer on the VM host and assume it changed kind.

```sh
make -C platform runtime ARGS='node-plan --bundle /path/to/runtime-arm64 --config /etc/containerd/config.toml --output /path/to/private-plan --node TARGET_HOSTNAME_LABEL'
```

`node-plan` is non-mutating: inspect `candidate.toml`, `before.toml`, `plan.json`
and `runtimeclass.json`. It parses TOML and proves that only the new handler is
added; the default runtime is unchanged. Config versions 2 and 3 are supported.
Configs using `imports`, symlink configs or an existing `runsc-xsphere` handler
require a separate operator review and are deliberately refused by this initial
guarded installer. Plans contain private node configuration: never commit them.

After reviewing the diff, confirming the bundle architecture and reserving a node
maintenance window, run on that same node as root:

```sh
make -C platform runtime ARGS='node-install --plan /path/to/private-plan --ack-node-change'
```

This installs into `/opt/xsphere/gvisor/<version-architecture-shimhash>/`, checks
the candidate with the node's `containerd config dump`, and atomically replaces
the unchanged original config. It does **not** restart services. The installer
also refuses PAC-enabled ARM64 CPUs for this restore profile; it never changes
VM CPU settings. Existing `runc`, `gvisor`, `gvisor-l2` and `runsc-l2` are untouched.

Activation is a separate operator step: confirm node service management and running
workloads, restart **only the selected node's containerd**, verify CRI RuntimeReady
and NetworkReady, then dry-run/create the generated RuntimeClass using an explicit
kubectl context. For the new kind path, the handler is configured during cluster
creation; use `runtimeclass-render` for the RuntimeClass with name `gvisor-xsphere`, handler
`runsc-xsphere` and `scheduling.nodeSelector.kubernetes.io/hostname` set to that node's
hostname label. Keep it unavailable to untrusted Pod authors.

If activation fails, keep scheduling on the previous runtime. After ensuring no
workloads need the new handler, restore the config with:

```sh
make -C platform runtime ARGS='node-rollback --plan /path/to/private-plan --ack-node-change'
```

Rollback refuses to overwrite later operator edits. It restores only the original
configuration; binaries, checkpoint directories and PVCs are retained. Restarting
containerd and removing an unused RuntimeClass are explicit operator decisions.
Do not delete runtime files while existing shims or recoverable snapshots need them.

## Compatibility Record

[gvisor.lock.json](gvisor.lock.json) distinguishes the historically tested
`release-20260817.0` binaries from the newer rebased source branch. The latter has
build/unit-test evidence only, not a new Pod end-to-end result. Digests are copied
from existing verification records; this import has not re-read installed binaries.

The minimal change is in `containerd-shim-runsc-v1`, which accepts the host image
path annotation and connects Pod creation to `runsc restore`. The historical
`runsc` binary itself was the official release. A RuntimeClass such as `gvisor-l2`
selects a containerd handler such as `runsc-l2`; these are configuration names,
not additional runtime implementations or CPU architectures.

The product chart still does not create RuntimeClasses or replace node binaries;
the runtime CLI is the separately acknowledged node operation. The tracked
[shim archive](../../_demo/gvisor-cr/restore-shim.md) provides source/build context.

Historical ARM verification required an ARM64 Linux VM with PAC disabled at CPU
configuration time. That reduces a VM security feature and is not the same as
fixing PAC in gVisor. Do not change production VM CPU settings through application
Helm values. Restrict initial use to the tested same-node, compatible-build setup;
retest a new runtime base or CPU feature configuration before promoting it.

The handler/config layout follows the [gVisor containerd guide](https://gvisor.dev/docs/user_guide/containerd/quick_start/)
and [containerd config version documentation](https://github.com/containerd/containerd/blob/main/docs/cri/config.md).
