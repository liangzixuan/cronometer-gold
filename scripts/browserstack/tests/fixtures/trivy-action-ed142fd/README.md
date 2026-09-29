# Pinned Trivy action test fixture

This stores the unchanged entrypoint bytes as Base64 from aquasecurity/trivy-action commit
`ed142fd0673e97e23eac54620cfb913e5ce36c25` (v0.36.0).

Source: https://github.com/aquasecurity/trivy-action/blob/ed142fd0673e97e23eac54620cfb913e5ce36c25/entrypoint.sh

SHA256: `5d35de70292a3461e55874ca658b3d8f6a56acc4d7098c64e546d965c34a0067`.

The regression decodes `entrypoint.sh.base64` into a temporary script and
verifies the decoded SHA256 before running it with an inert scanner stub.
Base64 preserves the upstream bytes while keeping this checkout free of trailing
whitespace. It does not invoke Trivy, Docker, or network services.

Licensed under Apache-2.0; see LICENSE. No NOTICE file is present at the
pinned revision.
