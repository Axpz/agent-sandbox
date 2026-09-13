# gVisor External Dependency

gVisor source, the restore-shim change and build tooling are maintained in
[Axpz/gvisor](https://github.com/Axpz/gvisor/tree/feat/shim-restore-host-image-path).
This directory only records the dependency and its integration boundary. It does
not contain a second patch copy, build wrapper or node installer.

## Pinned Source

- Development branch: `feat/shim-restore-host-image-path`.
- Fixed commit: [`7e3a4c73201e3ba06d825dc4e7e4d7887de545bd`](https://github.com/Axpz/gvisor/commit/7e3a4c73201e3ba06d825dc4e7e4d7887de545bd).
- Upstream base: `8865c1523f7af680f26eaa20ebcc702989ed4923`.
- Recorded verification: AMD64/ARM64 shim builds and unit tests. **Pod restore E2E
  has not been rerun on this source base.** Pin the commit, not the moving branch.

The shim accepts `dev.gvisor.internal.restore.host-image-path` and invokes
`runsc restore` during Pod creation. This is not an ARM64 PAC fix or automatic
checkpoint coordination in sandbox-api.

## Artifacts and Node Integration

No downloadable custom binary release is recorded here. Build the pinned source
using its [build instructions](https://github.com/Axpz/gvisor/blob/7e3a4c73201e3ba06d825dc4e7e4d7887de545bd/README.md#installing-from-source),
or reuse a previously verified artifact with recorded checksums. Official upstream
releases must not be assumed to contain this custom shim change. Keep source commit,
architecture, build options and artifact checksums together. Follow that source's
packaging layout, including required sidecars; do not mix arbitrary runsc/shim versions.

Node installation is separate from xsphere Helm deployment. Review the pinned
[containerd integration guide](https://github.com/Axpz/gvisor/blob/7e3a4c73201e3ba06d825dc4e7e4d7887de545bd/g3doc/user_guide/containerd/quick_start.md)
against the selected node's containerd version before making changes:

1. Back up node configuration and retain the current binaries. Install a compatible
   runtime in a versioned directory with a separate containerd handler; leave the
   default runtime unchanged. In kind, configure the node container, not host containerd.
2. Configure annotation forwarding (`pod_annotations = ["dev.gvisor.internal.*"]`)
   and an access-controlled checkpoint directory visible to the node runtime.
   Review node activation in a maintenance window and verify CRI health.
3. Select the existing RuntimeClass in the business template. For the optional
   chart template, set `runtime.runtimeClassName` to that class. Names such as
   `gvisor-l2` / `runsc-l2` are configuration names, not versions. The chart neither
   creates the RuntimeClass nor installs the handler.

Before rollback, stop scheduling to the new handler and account for its running
workloads. Restore the reviewed previous configuration without overwriting later
operator changes; restart the selected service only in an approved maintenance
window. Retain binaries needed by existing shims, checkpoint artifacts and PVCs.

## Historical Compatibility

Earlier same-node Pod tests used official `release-20260817.0` runsc
(`50e1502a95d36ad2faf2c7ef33b8bf21fe975293`) with a locally patched shim, not the
newer source pin above. The immutable [build and checksum record](https://github.com/Axpz/agent-sandbox/blob/9d94c78542c2d0380a041c1edda5bf6a4bc8c100/platform/runtime/gvisor.lock.json)
and [source/build archive](https://github.com/Axpz/agent-sandbox/blob/9d94c78542c2d0380a041c1edda5bf6a4bc8c100/_demo/gvisor-cr/restore-shim.md)
preserve the old patch and reproduction details without maintaining them here.
These fixed-commit URLs retain their original directory names so the evidence
remains accessible after the product directory rename.

The tested scope was one node and a single application container. ARM64 required
a Linux VM with PAC disabled; disabling PAC reduces VM protection and is not a
general ARM fix. Keep the runtime, CPU features, business image and PVC compatible.
Validate new builds with real Pod restore tests before promotion. Failed application
restore cleanup taking about two minutes remains a recorded limitation.

Artifacts contain sensitive process memory. Restrict host-path annotations to
trusted workloads. The [lifecycle guide](../docs/lifecycle.md) explains quiescing,
artifact completion and recovery failure handling. Current sandbox-api pause/resume
preserves PVC data, **not process memory**; node setup alone does not change that.
