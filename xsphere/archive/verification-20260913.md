# Product Import Verification: 2026-09-13

The first table records the initial import. See **Unified Portal Verification**
below for the follow-up that added runtime delivery and completed Nginx syntax testing.

This is a historical record of the initial product baseline, published as
[`9d94c78`](https://github.com/Axpz/agent-sandbox/commit/9d94c78542c2d0380a041c1edda5bf6a4bc8c100).
The subsequent simplification removed the local gVisor CLI, its tests and patch
copy. Use the [runtime reference](../runtime/) for current ownership and versions;
the runtime commands and 62-test count below describe that earlier baseline.
Directory references below use the current `xsphere/` name for readability;
results remain historical. The linked commit preserves the original paths and
commands. See the [product README](../README.md) for current verification steps.

Scope: the product integration, now under `xsphere/`, on `product/xsphere`. No live Kubernetes,
VM, node runtime, existing controller or original API repository was changed.

| Check | Result |
| --- | --- |
| `make -C xsphere install` | Frozen Bun lock accepted |
| `make -C xsphere check` | Passed lint, Helm lint, TypeScript check, 19 tests and Bun build |
| Repeat check after build | Passed; generated `dist/` excluded from lint |
| API Docker build | Passed using the production dependency install |
| ARM64 API image smoke | Passed HTTP `/health` and `/openapi.json` on loopback inside a `--network none` container |
| Source preservation | All 15 imported source-file hashes still match the untouched original working tree |
| Archive patch digest | Matches the tracked gVisor patch |
| Local documentation links | Resolve; no raw kubeconfigs, credentials or runtime artifacts imported |
| Nginx container syntax check | Not run: image pull stalled for over five minutes and was canceled |
| New chart/SDK cluster E2E | Not run; deployment requires a separate environment review |

Tools used: Bun 1.3.5, Helm 3.16.4, local Docker targeting Linux/ARM64.
The API smoke used only `sandbox-api/test/fixtures/offline-cluster.yaml`, which
contains a reserved non-routable domain and no credentials or exec plugins.
No real cluster requests were issued; the test container exited and was removed.

Local image: `sandbox-api:xsphere-dev`, Linux/ARM64, not pushed to a registry.
Local image ID reported by Docker:
`sha256:371a7933ad7b91d51f99f4fa4e0487f152f07f051b4691786817bdcf1e551671`.
This is a local build record, not a published registry digest or an AMD64 result.

At this initial checkpoint, Nginx and isolated-namespace SDK E2E were pending.
Existing historical ARM/AMD memory tests remain separate;
this API import does not implement automatic memory checkpoint coordination.

## Unified Portal Verification

The follow-up adds the pinned gVisor CLI, node candidate/install/rollback workflow,
kind/RuntimeClass rendering, shared controller/Router build entries and image smoke
checks. Node activation is explicitly opt-in, not part of local verification.

| Check | Result |
| --- | --- |
| `make -C xsphere check` | Passed: 20 API/config/chart tests, 21 runtime tests, 21 image-tool tests; lint, typecheck and API build passed |
| Controller chart through product entry | Rendered with an overridden namespace and extensions enabled |
| `prepare` and `verify-source` | Applied the actual archived patch to the exact gVisor commit in a fresh checkout; verified no extra source changes |
| Public upstream tag | `release-20260817.0` peels to the locked `50e1502a95d36ad2faf2c7ef33b8bf21fe975293` |
| `fetch-runsc --arch arm64` | Downloaded official binary, SHA256 and ELF architecture matched; isolated Linux container reported `release-20260817.0` |
| Controller and Router builds | Both built as static Linux/ARM64 ELF binaries through `make -C xsphere controller-build router-build` with explicit cross-build environment |
| API image smoke | HTTP health and OpenAPI passed in a network-isolated ARM64 container |
| Edge configuration smoke | Passed `nginx -t`, including the optional frontend, using the official Linux/AMD64 Nginx 1.28.0 image |
| Runtime node transactions | Temporary-filesystem tests covered additive v2/v3 configuration, checksum/architecture checks, failed validation, stale plans and rollback preservation |

For the shared Go binaries, the command used was:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 make -C xsphere controller-build router-build
```

The ARM64 Nginx layer stalled through both attempted registry routes. The AMD64
image was downloaded successfully and explicitly selected for the syntax test:

```sh
EDGE_PLATFORM=linux/amd64 make -C xsphere smoke-images
```

This validates Nginx configuration, not ARM64 Nginx startup or a full ARM cluster.
The owned smoke containers were removed. No existing cluster, service or VM was changed.

Not performed: a fresh gVisor shim compilation on Linux/amd64, native ARM64 shim
unit execution, real-node installer activation/rollback, newly built controller/Router
container images, or new Kubernetes/SDK E2E. Those remain promotion gates; the
historical memory tests are not substituted for them. Runtime transaction tests use
synthetic ELF fixtures and a mocked containerd config validator, not a live daemon.

## Publication Decision

Suitable for publishing to `Axpz/agent-sandbox` on `product/xsphere` as a **development
integration baseline**, not as a production release. The remote was reachable and
did not yet contain that branch when checked. No commit or push was performed.

Scope for the eventual reviewed commit: the product directory (now `xsphere/`), root `.dockerignore`, and the
small image-discovery exclusion plus regression test in `dev/tools/push-images`
and `dev/tools/push_images_test.py`. Existing unrelated controller edits and raw lab
files must remain unstaged. Exclude downloaded binaries, build output, node plans,
kubeconfigs and credentials. The original standalone API working tree is retained.
