# CodeSphere daemon startup correction — 2026-09-29

The development cluster was running a runtime whose Jupyter startup script also
started the CodeSphere daemon. Backend `sandbox.py` independently starts that
daemon after creating the sandbox and writing its token, passing both
`AGENTSPHERE_SANDBOX_ID` and `CODESPHERE_SANDBOX_ID`. Backend logs reported
`hello.sandbox_id=sbx_unknown` for the old sandbox.

The corrected runtime starts only envd and Jupyter at boot. Backend `sandbox.py`
remains the sole daemon startup entry. No backend or daemon source changes were
needed.

## Deployment

- Previous image: `codesphere-runtime@sha256:28618f46b83dfbf2322609ed0efdbfc461c899c244df46cb04e037535406be09`.
- Corrected image: `codesphere-runtime@sha256:cb6027af6da2e50fadbcd0ec8cd2662499e1e30960e4c095f6b4edde8367bbd4`.
- The correction was built on the existing `codesphere-runtime:pi-envd-agentsphere-base`
  image by copying `deploy/codesphere/runtime/entrypoint.sh` and `start-up.sh` to
  their existing destinations with mode `0755`. The full runtime Dockerfile also
  installs these scripts.
- The image was loaded into kind, including its digest reference, and the live
  `sandbox/xsphere-runtime-template` image was updated. The warm pool recreated
  its unused sandbox.
- With user authorization, the old business sandbox was deleted through the
  backend action API. Its cleanup worker marked it deleted and cleared connection
  and Redis state. Its PVC and checkpoint resources disappeared; residual disk
  checkpoint artifacts were removed.
- `deploy/codesphere/xsphere-values.yaml` pins the corrected image for future
  deployment. That file describes a separate release; it was not applied wholesale
  over the live deployment.

## Observations and limits

The replacement warm-pool Pod is Ready, with envd as PID 1 and Jupyter/kernel/
interpreter processes present. No daemon or daemon supervisor is running before
backend startup. The local envd health endpoint returns HTTP 204.

Shell syntax checks passed. No new unit tests or end-to-end tests were run for
this deployment. A business sandbox creation/handshake was not exercised.
Existing S3 snapshot failures and pause/resume issues remain separate findings.
