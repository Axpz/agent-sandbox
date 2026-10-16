# gVisor Baseline

Verified and deployed on **sanjxmgmt / ARM64** and **55 / AMD64**, 2026-10-07.

- Source: [Axpz/gvisor](https://github.com/Axpz/gvisor/tree/xsphere/release-20260831.0), branch `xsphere/release-20260831.0`.
- Commit: `02fda6871a33c6646ddc1f0b83a67cfc81e329fe`, based on upstream `release-20260831.0`.

| Architecture | Custom shim SHA-256 | Official runsc SHA-256 |
| --- | --- | --- |
| ARM64 | `4f943fdbf94082b5fac187ae8d7456af2b43d4c9e8955c1a555ad9e4a4a1a476` | `d5679775682cd4cb11ba7bf7bd8e04235622aa8797d518dd280064e5cd27ed5d` |
| AMD64 | `4e57935087b45472fddca181be04e16e59e5adb65d2eefcf7a03a09b50f9976a` | `1a4995a70b3c8b7d36f55d7d2dc6d15185ebe420de653b1a330b42d36c0e6b4a` |

Only the shim was rebuilt. runsc and auxiliary binaries are unmodified upstream artifacts.
Each architecture passed 29 unit tests and a pause/resume memory check.
Backups and rollback scripts: sanjxmgmt `/root/xsphere-shim-02fda6871/`;
55 `/orchestrator/xsphere/data/gvisor/upgrade-20260831-amd64/`.

This file is the current baseline; source and build tooling stay in Axpz/gvisor.
