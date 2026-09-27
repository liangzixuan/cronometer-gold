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

## Account passwords

Login, account creation and password reset use the same limits: 12–128 Unicode
code points and at most 512 UTF-8 bytes. The password field must accommodate
every accepted value. Preserve passwords exactly, including spaces and combining
characters; do not trim, normalize or truncate them.

Reject an invalid password before submitting the account request, explain the
length requirement and focus the field. Keep the entered value available for
correction. Existing email, origin, session-cookie and response checks still apply.

## Diary session recovery

Dashboard and Diary verify the session before loading a private day. A temporary
session failure offers Retry session without presenting an empty day or zero
nutrition. Keep a valid selected date; otherwise use the recovered profile's local
day. Once the session is verified, a failed day read uses its own Retry action.
A successful day read must not hide a session error.

Repeated or outdated retry actions must not create extra requests, disturb a
ready editor or replay a save. Session closure, route replacement and leaving the
screen invalidate pending reads. An expired or replaced account requires signing
in again; a failed sign-out attempt must leave a usable recovery path.

## Diary entry saves

Keep the submitted quantity, meal, local date, local time and private note visible
while a save is pending. Disable those fields and Clear, Save and Cancel until
the request settles. Other entries cannot be opened for editing during the save;
saved nutrient details remain available. Old callbacks must not change a newer
editor or start a duplicate save.

An unconfirmed save keeps the raw draft available. Retrying it unchanged reuses
the original request, operation identity and revision/time-zone preconditions.
Fresh controls allow editing again after the failure. A confirmed matching receipt
closes the editor and refreshes the affected day. Existing conflict recovery,
owner checks, private-session closure and immutable entry history remain intact.

## Personal foods

Foods has two destinations: Catalogue for published foods and My foods for the
user's private library. The authenticated `/foods/custom` route owns creation,
revision, copying, archiving and logging a saved food version. Health & privacy
loads its nutrient registry independently for Trends.

The food editor and saved library sit beside each other on desktop and stack on
narrow screens. Nutrient controls wrap with their row, and actions have at least
44 px hit targets. Keep saved-food details separate from unsaved editor values.
A valid selected diary date follows Foods navigation and initializes a newly
opened log. Changing that route date does not overwrite an open logging draft.
Owner checks, draft choices and exact retries apply on the dedicated page as they
do elsewhere in the app. Revising a food never rewrites past diary entries.

## Recipe drafts

New recipe, opening a saved recipe and copying a saved version use the same
inline replacement choice when the builder has unsaved edits. Keep editing
leaves the builder, ingredient order and notes, selected nutrition and diary-log
draft intact. Discarding edits starts a blank recipe, copies the loaded saved
version, or opens the named saved recipe. Opening replaces the builder only after
that recipe loads successfully.

A revision conflict preserves the rejected draft and its expected revision.
Loading current saved values requires an explicit replacement choice. Active
saves and logs cannot be interrupted by New or Open, and an old choice cannot
replace newer edits. These protections cover the current recipe page; they do
not add persistent autosave or protection from every navigation or browser close.

## Personal recipe ingredients

The recipe builder offers My foods alongside public catalogue search. Load the
private library when needed, filter the foods already loaded, or load another
page. Retry and refresh affect that picker independently of the recipe draft.
Manage the library from the My foods page.

Add 100 g or the food's saved serving, then use the ingredient's existing quantity,
note and ordering controls. Each ingredient keeps the version and serving chosen
at that moment. Refreshing the library changes future choices; it does not repin
existing ingredients. Private foods retain private provenance and unknown
nutrients. An archived food cannot enter a new or revised recipe, while an
existing saved recipe snapshot remains loggable.

## Goal drafts

Keep entered goal values separate from the saved goal used for progress. New,
Copy and a change of progress date use an inline Keep editing / Discard edits
choice before replacing a dirty editor. Keeping edits retains the original date
and goal context. A failed replacement read leaves the draft available.

A rejected save keeps the entered values and expected revision. Loading saved
values requires an explicit discard. A changed eligibility profile still requires
fresh review; retaining edits must not carry an outdated reference selection into
a new save. Ambiguous saves retain their exact request and operation identity.
These controls protect the current goal editor; they do not provide persistent
autosave or protect every browser navigation.

Nutrient threshold rows fit the editor column: source details occupy a full row,
and threshold fields wrap to the available width. Editable and reference preview
rows must remain contained beside the progress panel at tablet sizes.

## Health trends

Nutrition and biometric trends load independently. Each card shows its own loading
state, result or error, with Retry for that card. Retrying one card keeps the other
card available. Changing a range or series hides results from the previous choice
immediately. An incomplete date range or Biometric None shows an explanation
instead of old rows.

Trend results remain tied to the signed-in owner, profile, selected dates and
series. Late responses cannot replace the current view. Preserve the server's
exact biometric values, nutrient coverage labels and profile-local day boundaries;
missing nutrition values remain unknown. Trend recovery must leave biometric,
reminder and privacy-action drafts alone.

## Reports session recovery

A temporary failure to verify the Reports session offers Retry session. It verifies
the current route and profile before loading its report. Keep report content,
printing and day inspection unavailable during verification. A failed report read
uses its own Retry report action after the session is verified.

Retry must ignore duplicate clicks and callbacks retained from an older route or
session. Late responses cannot restore closed private content or replace the
current route. Existing explicit date ranges and profile-local defaults remain
intact; a different owner or expired session requires signing in again.

## Activity and Hydration session recovery

A temporary failure to verify the Activity or Hydration session offers Retry
session. Once verification succeeds, load the selected local day through the
existing day reader. Keep Retry day view separate: it reloads a failed day read
without restarting session recovery or repeating a write.

Session retries ignore duplicate clicks and responses from an older route or
closed workspace. Preserve each tab's existing draft and owner-change behavior.
An unconfirmed save keeps its exact request for the existing explicit write
retry; session recovery must never replay it or discard its retry information.
Hydration sign-out remains available during session verification and prevents a
late response from reopening private content.

## Responsive layout

Keep main content centered within each route's width limit so wide screens do not
stretch forms or summaries excessively. Bound the Diary's numeric columns and
nutrient rail so long lines stay readable. Dashboard panels
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
