# Frontend design and product walkthrough

Use a populated daily flow as the review unit: Dashboard → Diary → Add Food →
Nutrition Report → reload. Keep the product usable as each capability is added.
A template or synthetic fixture does not establish Cronometer or Gold parity.

## Calm Daily

The user approved the refined Calm Daily concept on September 25, 2026. It uses
warm ivory surfaces, near-white panels, dark brown sans-serif headings, olive
nutrition progress and terracotta actions. The Dashboard summarizes the selected
day; the Diary keeps detailed editing. Daily Ledger contributes aligned entry
rows, Meal Journal contributes warmth, Nutrient Atlas contributes precise nutrient
states, and Focus contributes selected-date and meal continuity.

The application theme is scoped to `.shell` in `apps/web/src/app/daily-theme.css`.
The public landing page keeps its separate styling. Shared `AppNavigation` retains
the selected date between daily routes, keeps Reports' range on its own page,
and groups Goals, Hydration, Activity and Health & privacy under More. Native
disclosures keep secondary navigation and account actions keyboard-accessible.

`/overview` uses the guarded diary reader and `CalmOverview`; `/dashboard` remains
the detailed Diary. Whole-day nutrient totals include entries beyond the loaded
page. Meal summaries disclose incomplete pagination and withhold a full-meal
energy total until all entries are loaded. Food names and meal labels come from
saved data. No generic food photos, photo placeholders or upload requirement are
part of the diary design.

Saved targets use the existing goal-progress endpoint. The client checks the
selected day, diary revision, profile and current session before presenting them.
No saved target means no invented percentage or remaining calories. Unknown
nutrients have no progress bar; partial amounts and percentages remain lower
bounds. Remaining energy appears only for an exact, comparable energy total and
saved target. Water, activity and private notes retain their existing persistence
and ownership boundaries.

Macro icons keep explicit labels and units: flame for Energy, sliced egg for
Protein, wheat for Carbs and cooking-oil bottle for Fat. They are decorative
symbols, not nutrient-source claims. Standard interface icons reuse the licensed
Font Awesome 5.12.0 font from the installed Bootstrap Studio SB Admin export.
The three generated nutrient assets and their provenance are in
`apps/web/public/images/nutrients/README.md`; font provenance is in
`apps/web/public/fonts/`. No new package or remote asset service is required.

## Responsive layout

Use available width without a fixed desktop content cap. Bound the Diary's
numeric columns and nutrient rail so long lines stay readable. Dashboard panels
sit side by side on wide screens, use fewer columns on tablets and stack on
phones. Navigation keeps its own scroll area on narrow screens, with More and
Account accessible outside that strip. Food names wrap, controls remain usable,
and no page-wide horizontal scrolling is required. Use relative type sizes and
test increased text size as well as viewport width.

Check Dashboard and Diary at 320, 390, 768, 1100, 1487, 1920 and 2560 CSS pixels.
Also check Foods, Reports, expanded navigation, editing and error states at narrow
widths. Real saved values may differ from the approved illustrative mockup; record
those differences rather than changing data to match an image.

## Bootstrap Studio handoff

Bootstrap Studio remains a visual authoring workspace. Port approved layout and
scoped styles into the existing Next/React components. React owns session state,
forms, dialogs, retries and persistence. Do not replace working routes with static
template pages or introduce template scripts that also control React's DOM.

Keep the editable `.bsdesign`, original template/theme export, importable page,
readable export and provenance together in the local design workspace. Use linked
components for repeated headers. Review Online Library markup, dependencies,
license and keyboard behavior before adoption. Disable CDN use and minification
for review exports. The Calm implementation is based on the approved concept;
it is not a new installed Bootstrap theme or a claimed Studio export.

## Verification

Follow [the maintained walkthrough](../quality/local-walkthrough.md) for synthetic
population and ownership-checked lifecycle commands. Use Brave for actual app
review. Check navigation, focus, responsive layouts, loading/failure states,
add/edit/repeat, report agreement and persistence. Keep concept images and Studio
screenshots separate from application evidence. Use an outside-Git design QA
record for paired reference/render comparisons and actual source identity.

The repository remains authoritative for shipped behavior. Catalogue capacity,
real publisher coverage, account delivery, device qualification and release gates
remain in the [beta checklist](beta-exit-checklist.md).
