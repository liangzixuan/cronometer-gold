# ADR 0004: Consumer-wellness product boundary

- Status: Accepted
- Date: 2026-08-15
- Owners: Product, clinical/scientific review, legal/privacy review

## Context

Nutrition and biometric data feel medical even when a product is intended for
general wellness. Product copy, algorithms, alerts, integrations, and professional
workflows can shift regulatory, safety, and contractual obligations. A disclaimer
does not cure unsafe product behavior.

## Decision

The initial product tracks self-reported food and general-wellness metrics. It may
explain established calculations, uncertainty, and trends. It must not:

- diagnose, screen for, predict, prevent, or treat a disease;
- recommend medication/insulin dosing or replace clinician-prescribed targets;
- claim that a nutrient score or wearable value is medically accurate;
- present acute biometric alerts as emergency monitoring;
- silently turn incomplete food data into reassuring conclusions.

Health guidance uses neutral language such as “recorded,” “estimated,” and
“compared with your selected target.” Medical-condition goals, pregnancy,
pediatrics, eating-disorder interventions, renal dosing, glucose dosing, and
bioavailability claims require scoped scientific, clinical, legal, and UX review
before implementation.

Every formula has a named source/version, input assumptions, eligible population,
units, and edge-case tests. The UI distinguishes measured, label, estimated, trace,
and missing values. Users can inspect and correct inputs. Integrations request the
minimum data types, identify their source, avoid feedback loops, and never imply
continuous clinical monitoring.

Privacy architecture treats nutrition and biometrics as sensitive health-adjacent
data regardless of whether HIPAA applies. The product supports consent, access,
export, deletion, least privilege, encrypted transport/storage, and audited
administrative access from the beginning.

This ADR is a product-engineering boundary, not legal or medical advice.

## Consequences

- Some high-retention features are postponed until evidence and review exist.
- Copy and notification templates need scientific/safety review, not only design QA.
- Professional/coaching features require a separate assessment of covered-entity,
  business-associate, clinical-workflow, and record-retention implications.
- The schema preserves provenance and uncertainty so the UI can communicate limits.

## Escalation triggers

- Provider/insurer/employer contracts or clinician-directed care.
- Any claim tied to disease, treatment, fertility, pregnancy, pediatrics, or dosing.
- CGM interpretation, acute alerts, or automated recommendations from biometrics.
- Research, model training, advertising, or third-party sharing of health data.
- Entry into a new jurisdiction or app-store health category.
