# ADR 0019: First-release parity sequencing and camera barcode capture

- Status: Source implementation complete; signed-device and live-catalogue
  evidence remain blocked
- Date: 2026-09-07

## Context

The source contains a substantial correctness and release-evidence foundation,
but infrastructure hardening can consume the roadmap while approval-gated live
catalogue, deployment, and device work remains unavailable. The first useful
release still needs broader daily food-logging workflows. Camera barcode
capture is a high-impact user-visible gap whose exact lookup and confirmed-add
backend already exist.

Camera input also creates a new native permission and lifecycle boundary. It
must not turn a decoded identifier into image retention, fuzzy food inference,
automatic logging, or a broader durable outbox.

## Decision

Until the first signed parity build is accepted, safe user-visible daily
logging and release-path viability lead source sequencing. Non-blocking
hardening stays queued unless it responds to a demonstrated P0/P1 correctness,
privacy, security, data-loss, cross-owner, or release-authority defect, or is
required by the next controlled-beta exit gate. This scheduling decision does
not waive any food rights/provenance, catalogue authority, privacy,
authentication, deployment, or signed-device gate.

Camera barcode capture is a native, ephemeral input adapter over the existing
exact GTIN contract:

- Camera permission is requested only from an explicit Scan action.
- Frames remain on-device and no photo or video API is used.
- One mounted scanner consumes at most one detection and unmounts on success,
  cancel, error, or app backgrounding.
- Only EAN-8, EAN-13, UPC-A, and ITF-14 decimal payloads are accepted. UPC-E,
  arbitrary symbologies, OCR, fuzzy correction, and inferred food creation are
  rejected. Expo Camera's exact iOS UPC-A representation (`ean13` with 12
  digits after its synthetic leading zero is removed) is accepted as UPC-A.
- The existing authoritative lookup performs GS1 check-digit validation.
- Manual entry remains available and a lookup result still requires explicit
  confirmation before the existing add flow.
- Barcode data is not persisted durably, on disk, or in ADR 0013's quick-add
  envelope.

Cloud, DNS, Terraform, workflow, Tailscale, firewall/listener, phone, live
catalogue, and EAS/signing actions retain their separate approval gates.

## Consequences

The source closes a meaningful daily-use gap without changing the API,
database, food contracts, or outbox. The native binary gains one camera
dependency and the CAMERA permission, while microphone/audio permission is
explicitly absent. Controlled beta still requires versioned signed-device
camera and accessibility evidence; existing P0 v2 evidence is not retroactively
broadened.

Live catalogue coverage remains an independent release blocker. A scanner makes
lookup easier but cannot compensate for missing reviewed food and GTIN records.

## Alternatives

- Continuing database-authority hardening as the default source sequence was
  rejected because the remaining actions are live-deployment gates, not the
  largest buildable user gap.
- Adding a new barcode backend or offline catalogue was rejected because the
  exact authoritative lookup already exists.
- UPC-E expansion in the client was rejected because it would create a second
  identifier-normalization authority.

## Review triggers

Review this decision before adding frame or image retention/upload, barcode
history, background camera use, photo/OCR or new symbologies, UPC-E expansion,
automatic diary logging, offline catalogue lookup, or barcode fields in any
durable client envelope.
