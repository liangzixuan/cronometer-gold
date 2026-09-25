# Frontend design and product walkthrough

Use a populated daily flow as the review unit: Dashboard → Diary → Add Food →
Nutrition Report → reload. Keep the current product usable as each capability is
added. A template, passing source tests or a synthetic fixture does not establish
Cronometer or Gold feature parity.

## Bootstrap Studio handoff

The user selected Daily Ledger from five visual directions on September 25, 2026.
It uses a compact navy sidebar, teal actions, a grouped food ledger and a nutrient
rail. The installed SB Admin full-site template informed the navigation and
content structure; Bootswatch Flatly was a separate theme reference, not a theme
applied inside the locked SB Admin template. Reuse their established patterns
for labeled controls, responsive spacing and compact summaries. Keep typography and
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

## Daily Ledger

Keep the primary flow on one screen: select a day, scan meals, add a food, edit a
portion and inspect that day's nutrients. Food names, portions, energy and Edit
are visible on each row. Native disclosures hold attribution and secondary
actions; they preserve keyboard access and the existing retry and repeat flows.
On narrow screens, rows stack without removing controls or shortening food names.

The summary strip uses authoritative whole-day totals, including entries beyond
the loaded page. Nutrient rows retain unknown, partial and trace qualifications.
The diary does not load goal progress, so it links to saved targets rather than
inventing remaining calories or progress bars. Water, activity and private day
notes use their existing data and persistence boundaries.

Navigation reuses the unmodified Font Awesome 5.12.0 solid font from the installed
SB Admin export. Its license and provenance are in `apps/web/public/fonts/`.
Only the font is used; no template JavaScript or additional package was added.

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
