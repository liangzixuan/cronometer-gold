# Frontend design and product walkthrough

Use a populated daily flow as the review unit: Dashboard → Diary → Add Food →
Nutrition Report → reload. Keep the current product usable as each capability is
added. A template, passing source tests or a synthetic fixture does not establish
Cronometer or Gold feature parity.

## Bootstrap Studio handoff

The selected design foundation is the installed SB Admin full-site template and
integrated Bootswatch Flatly theme. Reuse their compact sidebar/content layout,
summary cards, labeled controls and responsive spacing. Keep typography and
spacing consistent across screens instead of selecting a new template per feature.
Use the Online Library to compare established component patterns before writing
one. Inspect the component's markup, scripts, dependencies, license and keyboard
behavior before adopting it.

Keep the editable `.bsdesign`, original template/theme export, importable page,
readable export and provenance together in the local design workspace. Use
Studio's linked components when navigation or headers are shared across multiple
prototype pages. Turn off CDN use and minification for review exports. Verify
desktop and narrow layouts after import: the importer may normalize HTML classes
and form values.

Bootstrap Studio is the visual authoring workspace. Port approved layout and
scoped styles into the existing Next/React components. React continues to own
session state, date selection, forms, dialogs, retries and persistence. Do not
replace protected routes with static template pages or add template JavaScript
that also controls React's DOM. Do not import demonstration values into production
components. Use existing dependencies first; new packages require a concrete need
and the usual dependency review.

The application theme is scoped to `.shell` in `apps/web/src/app/daily-theme.css`.
The public landing page keeps its separate styling. `/overview` composes the
existing guarded diary reader with a small `DailySummary` component; `/dashboard`
remains the diary route. Both use the same owner, date and snapshot boundaries.
Nutrition cards show whole-day totals and explicit unknown/lower-bound states.
No target percentage, energy balance or chart should be invented from absent data.

## Verification

Follow [the maintained walkthrough](../quality/local-walkthrough.md) for synthetic
population and ownership-checked lifecycle commands. Use Brave for the actual
app review. Check navigation, keyboard focus, narrow layouts, data loading/failure
states, add/edit/repeat, report agreement and persistence after application restart.
Keep Studio screenshots separate from real application evidence.

The local design workspace is a handoff artifact, not application runtime input.
The repository remains authoritative for shipped behavior. Catalogue capacity,
real publisher coverage, account delivery, device qualification and release gates
remain in the [beta checklist](beta-exit-checklist.md).

References: [Studio import](https://bootstrapstudio.io/docs/importing.html),
[themes](https://bootstrapstudio.io/docs/themes.html),
[exports](https://bootstrapstudio.io/docs/exporting.html),
[linked components](https://bootstrapstudio.io/docs/linked-components.html), and
[Bootstrap with JavaScript frameworks](https://getbootstrap.com/docs/5.3/getting-started/javascript/#usage-with-javascript-frameworks).
