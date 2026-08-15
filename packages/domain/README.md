# Domain package

Deterministic nutrition-domain primitives shared by the API, import workers, web
client, and mobile client. Runtime code in this package has no database, clock,
filesystem, network, or framework dependency.

## Semantics

- Decimal inputs should cross API and persistence boundaries as strings. Results
  are canonical, non-exponential decimal strings; display rounding is a caller
  concern.
- A quantified value of `0` is different from `unknown`. `trace` means analyzed
  but below a quantification limit. Aggregates expose a known lower-bound sum and
  coverage counters instead of silently replacing missing facts with zero.
- Mass-to-volume and household-to-mass conversions require a food-specific
  serving or an explicit density. The package deliberately has no generic
  `cup -> gram` conversion.
- Recipe nutrient mass is calculated before final-yield concentration. A measured
  or explicitly estimated yield is mandatory. Existing diary entries contain a
  runtime-frozen resolved snapshot and never depend on the current food or recipe
  version.

Run `pnpm --filter @nutrition-tracker/domain test` from the workspace root.
