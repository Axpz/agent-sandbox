# gVisor runtime

Source and build/install tooling live in [Axpz/gvisor](https://github.com/Axpz/gvisor),
on `xsphere/main`. This repository references that runtime; it does not duplicate
its patches or node installer.

- Coordinated xsphere tag: **1103.1**.
- Source commit: `8daf1a4aa63ddbc2c07bb302ab086a9ec8b8ee22`.
- Upstream base: `release-20261026.0`.
- Customizations: ARM64 PAC checkpoint/restore and the shim's host-image-path
  restore integration.
- `1103.1` uses exactly the same gVisor commit as `1029.1`; existing Linux AMD64
  installation archives remain at the [1029.1 release](https://github.com/Axpz/gvisor/releases/tag/1029.1).
  Checksums are pinned in [`release.json`](../release.json). No runtime rebuild is
  implied by the coordinated version label.

Register the installed runtime as `gvisor-x` for new K3s profiles. Existing
RuntimeClasses and running sandboxes are not renamed by a source release.
Preserve compatible images, runtime binaries, checkpoint files and PVCs when
planning an upgrade. A tag or Pod Ready alone does not establish memory recovery.

Historical shim-only artifacts and their test scope are retained in the
[2026-10-07 record](../archive/runtime-baseline-20261007.md). They are not the current
runtime package. The current release reuses prior build/test evidence; it does not
claim a new node-reboot or end-to-end restore test.
