# Frozen 55 Baseline

[Product entry](../README.md). The frozen commit is `48eb265e` on
`baseline/55-20261004`; later documentation and development can live on other
branches without changing that reference.

`55-20261004` identifies the AMD64 installation observed on 2026-10-04. The
[lock](../archive/baseline-55-20261004.json) and
[source checksums](../archive/baseline-55-20261004.sha256) belong to the Git commit
that introduces them. `sourceBaseCommit` is only its starting point: that older
commit does not contain all the captured live changes. This snapshot keeps chart
version 0.2.0; it creates no release tag or production-readiness claim.

The capture read the cluster without deploying, restarting workloads or invoking
pause, resume or connect. It imported no Secrets, customer data, PVC contents,
checkpoint memory, image layers or runtime binaries.

## What Is Frozen

- The live API's 13 TypeScript source files, `package.json` and `bun.lock` match
  this tree byte for byte. The adopted changes remove the restore verification
  Job while retaining node/runtime/path checks and save replay integrity checks.
  Existing failure cleanup and connect-wait behavior are retained. The private
  worker protocol now accepts only `save`; do not pair this worker with an older
  API that sends `verify` requests.
- Four runtime scripts match the running warm-pool container byte for byte:
  entrypoint, envd recovery, setup and daemon startup. This does not establish a
  reproducible build of the private base image or its package installation step.
- The chart retains the live Edge's single-worker startup command. The observed
  profile renders the same Edge configuration and the same memory template fields.
  The only observed spec difference is Edge's stale `checksum/config` rollout
  annotation. The private snapshot retains its old value; applying the current
  rendering would change that annotation and can trigger a rollout.
- Eighteen container image records cover the controller, API, Edge, Router,
  CodeSphere, business runtime, data services and monitoring. Each records the
  running Linux/AMD64 manifest, config digest and the original reported image ID.
- The runsc and patched shim checksums identify external binaries. The live
  runsc is `release-20260817.0`, not the newer source pin in the runtime guide.
- The private backend `_sandbox_assets.py` hotfix is preserved in the local
  bundle. Its mounted bytes equal the ConfigMap bytes; the lock records the hash.
  Its syntax was parsed without running it. No full private backend source is
  imported into this repository, and its original Git commit remains unverified.

Image IDs need interpretation. Some are config digests; others are OCI archive
indexes containing multiple unrelated images, including the backend and frontend
together. The capture resolved the descriptor by its image-name annotation or
Linux/AMD64 platform, then checked the config and layer digests against the current
tag. Use `runningManifestDigest` to identify one image. A recorded digest is not
proof that a registry can serve it; no registry retrieval or image export was done.

## Check the Source and Local Bundle

From the repository root, at the baseline commit `48eb265e` (not a later
documentation or development revision):

```sh
make -C xsphere baseline-check
make -C xsphere baseline-local-check
```

These commands use `shasum -a 256`; on a host providing GNU coreutils instead,
pass `SHA256SUM=sha256sum`. The second command additionally requires
`xsphere/local/baseline-55-20261004/`, which is gitignored and restricted locally.
Missing or modified files fail verification. These checks are intentionally
separate from `check`: future source development must not rewrite historical
checksums to keep this old snapshot passing. The source list includes documentation,
so documentation edits can also make these historical checks fail on a later tree.

The lock's `localBundle.files` records hashes for the bundle, including its
`SHA256SUMS` file. The repository checksum list also checks those local paths when
running `baseline-local-check`, binding the private bundle to this commit rather
than trusting a replaceable checksum file alone.

The bundle contains:

| File | Purpose |
| --- | --- |
| `capture.json` | Observed resources, node configuration/mounts, runtime hashes and release inventory |
| `observed-resources.json` | Selected Kubernetes objects with server metadata removed; Secret references retained, Secret values excluded |
| `observed-crds.json` | Four observed CRDs, including their cluster-specific conversion configuration; not for applying across clusters unchanged |
| `image-content.json` | Image descriptors, config and layer identities; private registry references retained locally |
| `api-source.tar` | Exact live API source, package manifest and dependency lock |
| `runtime-scripts.tar` | Exact four live runtime scripts |
| `_sandbox_assets.py` | Exact private mounted backend hotfix |
| `observed-values.json` | Chart inputs derived from current deployment, template and Services, retaining observed image references |
| `pinned-values.json` | Render-only variant using the resolved image manifests, including the checkpoint worker |
| `capture-readonly.py`, `capture-images-readonly.py` | Capture provenance; fixed queries with no deployment operations |
| `observed-render.yaml`, `pinned-render.yaml` | Offline renders, not applied |
| `verify-render.ts`, `render-differences.json` | Read-only render comparison and the recorded stale Edge checksum difference |
| `SHA256SUMS` | Local integrity check, itself bound by the tracked local checksum list |

Keep this private bundle with the local baseline commit when handing off the
environment. A Git clone alone does not contain the hotfix or exact environment
configuration. The older `local/values-55.yaml` was not overwritten: it names an
older API/worker combination and is not the source of this baseline.

## Render and Reproduce Deliberately

```sh
make -C xsphere render \
  VALUES=local/baseline-55-20261004/observed-values.json
make -C xsphere render \
  VALUES=local/baseline-55-20261004/pinned-values.json
```

Both commands only render. The pinned profile changes image references without
changing their resolved config/layers. It requires the corresponding manifests
and layers to be staged under usable target-registry references before deployment.
Do not assume an imported node-local digest can be pulled from Docker Hub.

The observed resource list is evidence, not an apply-all installation file. It
includes allocated Service addresses, generated PVC bindings and monitoring
resources. Recreate intended resources through reviewed manifests, preserve
existing data, and provide Secret values through the destination's private process.
The generic CodeSphere manifests also differ from the observed names, mounts,
hotfix and inline environment configuration; they are not a byte-for-byte restore
of this installation.

Before reproducing elsewhere, obtain the pinned images and external runtime
binaries, preserve their hashes, and supply the environment-specific node name,
runtime/artifact paths, storage, DNS, TLS and application credentials. Start with
an isolated environment using the [bootstrap procedure](bootstrap.md). The source
API can be rebuilt using the existing Make/Dockerfile entry, but a rebuild is not
claimed to reproduce the old image digest. The private CodeSphere source commits,
Router build provenance and runtime base-image build still need independent records.

## Verification and Remaining Work

Newly performed for this capture: live source equality, resolved image content
comparison, hotfix syntax parsing, offline chart rendering, and
`make -C xsphere check` (50 Bun tests, 21 Python tests, typecheck, build and Helm
lint). Biome reports seven pre-existing warnings in dashboard tests, with no
errors. No Go controller code or CRD markers changed; no new Pod restore or
CodeSphere chat/Pi acceptance exercise was run.

Known current behavior is preserved: the backend WebSocket URL still needs to
match the eventual browser ingress; API-key enforcement is incomplete; storage
and memory artifacts remain local to one node. No Secret, data or memory backup
is part of this snapshot, so it cannot restore an existing stateful session by
itself. Runtime/image availability, actual business-session restore validation,
production access controls and data recovery remain separate delivery work.

## ARM64 Counterpart: sanjxmgmt

On 2026-10-06 (Asia/Shanghai), the existing sanjxmgmt installation was aligned as
`sanjxmgmt-55-arm64-20261006`. See the
[version lock](../archive/baseline-sanjxmgmt-55-arm64-20261006.json) and
[rollout and verification record](../archive/verification-sanjxmgmt-55-arm64-20261006.md).

The API uses the same `48eb265e` source, the controller uses official v0.5.4 ARM64,
and Router is built from the observed 55 revision `afc6c6a`. The runtime overlay
adds the same envd supervisor and recovery hook while retaining sanjxmgmt's business
daemon, envd binary, workspace mount and existing gVisor combination. CodeSphere
frontend/backend and data services retain their existing ARM64 versions; this is
a sandbox integration alignment, not a replacement of their private application source.

At the commit introducing this ARM64 lock, verify with:

```sh
make -C xsphere baseline-check BASELINE=sanjxmgmt-55-arm64-20261006
make -C xsphere baseline-local-check BASELINE=sanjxmgmt-55-arm64-20261006
```

The private bundle is `xsphere/local/baseline-sanjxmgmt-55-arm64-20261006/`.
It contains exact changed-component configurations, rollback patches, build inputs
and verification evidence. Generic chart values cannot reproduce the retained
legacy FUSE/privileged template fields without adapting that profile. Existing
claims keep their original template and image; the new base applies to newly
created sandboxes. No x86 checkpoint or image is used as an ARM64 artifact.

The subsequent CodeSphere application alignment is recorded separately in
[the application rollout record](../archive/verification-sanjxmgmt-codesphere-55-arm64-20261006.md).
It replaces the previously retained frontend/backend images without rewriting this sandbox baseline.
