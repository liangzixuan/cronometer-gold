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

Sign-out actions retained from a closed page cannot send another request. A
pending confirmation belongs to the mounted private-page generation that started
it; a late response cannot navigate or update a closed or replaced page. Current
sign-out still works during session recovery, and an unconfirmed attempt keeps
the existing retry path. Restarted effects clear only a retired logout busy state
so a fresh sign-out remains available.

Load more belongs to the loaded page, selected route and verified account that
presented it. Closed or replaced pages and completed or failed continuation
attempts retire their old callbacks. A pending correction blocks pagination.
Only a current continuation can append rows or handle session expiry; a fresh
retry keeps the existing cursor and coherent-page checks.

Meal-group saves belong to the mounted private-page generation and verified
account that presented the form. Retained submits cannot send a profile write
after leaving the page, account replacement or effect replay. Pending receipts
cannot update or navigate a retired page. Restarted effects clear a retired
profile busy state so current settings can save again. Keep the draft's original
owner and profile revision through a failed save and retry. While the profile
write is pending, retained label, reorder, Reset and Cancel actions cannot change
or discard the submitted draft. A failed write keeps those names and that order
available for retry; fresh controls allow changes again after the request settles.
The settings launcher also preserves the open form and submitted draft during a
profile save. Active diary corrections block retained settings launchers and
profile submits, matching the disabled controls. Fresh settings actions work
again after the correction request settles.
Move actions find their original stable meal group in the current draft. Repeated
actions move that same group, keep its label and stop at the first or last position;
they do not move a different group that now occupies the old position.
Confirm a save only when the returned profile matches the submitted normalized
meal labels and stable-slot order. A mismatched response keeps the raw draft and
original revision available with an unconfirmed-save message. An unchanged retry
uses those same settings; normal revision-conflict recovery can load fresh settings.

Diary group settings controls belong to the active account and page generation.
After sign-out, unmount, account replacement or effect replay, retained launcher,
rename, move, reset and cancel actions cannot change the form or status message.
Fresh controls remain usable, including exact retries after a failed profile save.
The pending-save guard and stable-slot movement still apply. Focused component
checks cover these transitions; browser and concurrent React acceptance remain open.

A timezone-conflict refresh belongs to the account, route and active diary
operation that requested it. Check ownership before handling session expiry and
after decoding the response. Late expired or foreign-account responses cannot
redirect a closed or replaced page. Edit, Repeat and reorder recovery cannot reload a new
account or route after the old refresh finishes. Current expired or replaced
sessions still require sign-in; current timezone recovery keeps its normal path.

Diary entry Move controls belong to their original account, route and page lifetime.
Retained controls cannot start a reorder after that lifetime ends. Digest preparation,
responses and decoded receipts must still belong to the current mutation before they
change the page, require sign-in or reload the day. Effect replay clears retired busy
state when no mutation is active, so a fresh move can start before an old response
arrives. Complete-day permutations, matching receipts and exact retries remain required.
Collapsing a meal does not retire its otherwise valid Move control.

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

Repeat today uses the actual click instant, including seconds and milliseconds,
in the current profile's local day. This preserves the current occurrence during
a repeated local minute. An uncertain repeat keeps that exact instant, request
and operation identity across clock or date changes. A fresh repeat after a
matching receipt uses the new click instant. Repeat to a different date retains
the existing noon policy and explicit destination confirmation.

## Diary recorded times

Each loaded entry shows its saved local clock with seconds, UTC offset and IANA
zone. Compute that clock from the immutable instant and saved zone. Keep the
original precise timestamp in a semantic time element. Earlier and Later entries
at the same local minute remain distinct; the current account or browser zone
does not replace their saved context. This display does not change entries,
ordering, totals or editing.

Nutrient Show/Hide controls and their sections use the same saved clock, UTC
offset and IANA zone in their accessible names. Identical foods logged in a
repeated local minute remain distinct. Each control keeps its own disclosure
state and target; opening nutrient details requires no extra request.

The outer More disclosure also names the saved portion, clock, UTC offset and
IANA zone. Users can identify identical food entries before opening their actions.
Keep native details/summary behavior and the existing forced-open repeat form;
the label does not add requests or change the selected entry.

Deletion confirmation names the food, saved portion, date, clock with seconds,
UTC offset and IANA zone, with the configured meal name. Identical Earlier and
Later entries remain distinct before deletion. Cancelling creates no request or
operation identity; an uncertain deletion keeps its exact retry.

The edit section keeps a visible saved-entry summary above the draft fields. It
names the food, saved portion, date, clock with seconds, UTC offset and IANA zone;
a semantic time element retains the original precise instant. The summary uses
the saved snapshot through draft changes and uncertain retries. Cancel restores
the row without an extra request.

The Repeat destination section names and describes its saved source above the
new date and meal fields. Show the saved food, portion, date, clock with seconds,
UTC offset and IANA zone, with the precise instant in semantic time. Destination
changes cannot relabel that source. Identical Earlier and Later entries retain
their own context; Cancel closes the form without a request.

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

The pinned-food log offers Today and Yesterday using the verified account's
local calendar at click time. Keep the saved version, exact portion, meal,
entered time and independent food-editor draft. These choices follow the same
editable-draft rules as the date field; an older pending log keeps its original
request. A changed day clears a repeated-minute choice, while the same day keeps
it. Logging and timezone review still require their explicit actions.

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

If the initial session check fails, Recipes offers Retry session. It verifies the
current owner before loading the saved list. A list failure after verification
keeps Retry recipes. Session retry preserves the builder and pending save/log
operations; only an explicit save or log action can retry a write. Sign-out or an
owner change closes the private workspace. Old retry callbacks and late responses
cannot restore it after a route change or unmount.

The saved-recipe logger offers Today and Yesterday in the verified profile's
local calendar. Read the current date when the person clicks. Keep the selected
revision, exact portion, meal, optional time and independent builder draft.
Changing the date clears a repeated-minute choice; choosing the same date keeps
it. Blank time stays automatic. These controls follow the existing pending-log
rules and never submit a log or confirm a timezone change.

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

## Saved recipe log confirmations

Report a saved recipe log only when its returned entry matches the submitted
recipe and version, numeric portion, meal, exact instant, account zone and local
day. Its affected-day receipt must identify that one day. An absent or unrelated
entry keeps the original request and key for an explicit retry; do not show a
successful log or change the selected day. Matching normal and replayed receipts
close the request. Equivalent decimal spellings and timestamp offsets remain
valid when they represent the same quantity and instant.
The saved confirmation shows the recipe name, meal, confirmed local day and clock,
UTC offset and IANA zone. Its semantic time keeps the exact submitted instant,
including an automatic time confirmed by retry. The diary link uses that saved
day. Later draft changes or failed writes leave this confirmation unchanged;
private-session closure removes it. Keep the existing live status announcement
and the saved confirmation available for review.

## My foods log confirmations

My foods confirms a pinned log only when its saved entry matches the submitted
private food identity and version, portion, meal, exact instant, profile time zone
and local day. Its affected-day receipt must identify that one day. An absent or
unrelated receipt keeps the raw log draft and the exact request for explicit retry.
A matching normal or replayed receipt closes the log form and retires that request.
Keep its saved food name and version, meal, local day, clock, UTC offset and IANA
zone visible after the form closes. The semantic time retains the exact submitted
instant, and the diary link keeps the confirmed day. Later log or editor drafts
and failed writes do not change this confirmation. Private-session closure clears
it. Keep the existing live status announcement without a second live region.

## Food diary date choices

Catalogue food logging offers Today and Yesterday beside the diary destination.
Both use the account's time zone and the current date when clicked. Yesterday is
one calendar day earlier, including across daylight-saving and month boundaries.
Keep the chosen meal, exact quantity and search or barcode result. The choice
only changes the draft date; adding a food still requires an explicit Add.

Keep these choices unavailable until the session and time zone are known and
while an addition is pending. An older route or closed page cannot change the
date. A timezone conflict still requires confirmation of the chosen local day;
Today and Yesterday do not supply that confirmation or discard an uncertain add.

The manual date field keeps its draft editable during session loading and an
earlier pending addition. It accepts a valid new day only from the current view;
an older input cannot replace newer edits, even after the date is restored.
A no-op keeps Add available. A genuine day change clears a selected repeated
minute. The pending addition keeps its original day and exact retry request.

## Catalogue food meals

Add uses the selected meal. A changed meal retires older Add and meal controls
before the next view renders; restoring its old value does not revive them.
Choosing the same meal keeps Add available. Meal edits keep the selected day,
local time, repeated-minute choice and any required timezone review.

The meal draft stays editable while the session loads or an earlier addition is
pending. An unconfirmed addition keeps its original meal and exact retry request.
An older route or closed page cannot replace the current meal.

## Catalogue food portions

Logging uses the amount and unit currently displayed for that food. Older
controls cannot log a previous portion or overwrite newer edits, even when the
raw values were changed and restored. A same-value choice keeps Add available.
Search and barcode results share the draft for one saved food version; other
foods keep their own quantities. While an addition is pending, keep its submitted
portion fixed and ignore retained quantity or unit actions.

## Catalogue food logging time

Catalogue search and barcode results share an optional local time beside their
date and meal. Blank time keeps the current instant for today, including seconds,
or local noon for another day. An entered minute uses the verified account zone.
A repeated minute requires an explicit Earlier or Later choice; a skipped or
incomplete minute must not send an addition. Keep the raw values for correction.

Changing the day, time or verified zone retires an older occurrence. A no-op keeps
it. Each automatic, entered and repeated-minute choice keeps its own exact retry
request after an uncertain response. Timezone recovery preserves the entered time
and requires review of the current day and time before a fresh explicit Add.

Catalogue and barcode Add require a matching public-food receipt. A private-food
entry cannot confirm either addition, even if its numeric version ID matches.
Keep the exact request for explicit retry after that mismatch.

The inline saved receipt shows the confirmed local clock time, UTC offset and
account zone. Earlier and Later additions remain distinct when a clock repeats.
Its machine-readable time keeps the precise confirmed instant. Later draft edits
cannot change this saved receipt or its diary-day link. An uncertain or unrelated
response must not produce a recorded-time receipt. Keep the single existing live
announcement; the inline receipt remains available for review.

## Foods session recovery

Foods keeps public search, suggestions and barcode lookup available while it
checks the initial session. A failed session read offers Retry session; a
confirmed signed-out response asks the person to sign in before adding food.
Recovery preserves the selected day, meal and exact quantity. Untouched defaults
use the recovered profile's local date and time.

Session retry ignores duplicate clicks, stale responses and closed pages. Once
initial discovery succeeds, changing the destination updates it locally without
reopening session recovery. Recovery never repeats an add or changes an
unconfirmed add's exact retry. Existing timezone conflicts still require an
explicit review of the local diary day. That confirmation belongs to the displayed
day and recovered time zone. Changing the day or route retires the old control,
even before the replacement renders; returning to the earlier day does not revive
it. Duplicate confirmations and callbacks from a closed page do nothing. Only a
fresh explicit Add can submit after the current day is confirmed.

If the profile read during timezone review confirms that the session expired,
ask the person to sign in. Keep the public results and the selected day, meal
and exact quantity. Do not parse the signed-out response or repeat the add.
Profile responses from an older destination or closed page must not change the
current timezone, diary groups or sign-in state.

Manual Search uses the current raw query and food type. Changed query or type
retires older forms, input/type controls and pagination before the next view
renders, including after edit-and-restore. A suggestion selection also retires
its previous manual form. Same-value query/type actions keep the current form,
results and in-flight read available. Typing alone does not submit a search.

A suggestion belongs to the query and food type that produced it. Changing either
retires that suggestion before the next view renders; restoring the query does
not revive it. A same-value query edit keeps it usable. Choosing a suggestion or
pressing Search consumes the old suggestions, so a retained click cannot issue
a second search or replace newer typed text. Current selection still uses the
full normalized food label within the query limit.

Barcode lookup submits the current normalized digits. Changing those digits
retires an older form and input before the next view renders, including after an
edit-and-restore. A same-value event keeps the current form usable. Typing does
not submit a lookup or cancel one already in flight; a fresh explicit lookup
can replace that request through the existing cancellation path.

Public food lookup stops when its page closes. Retained query or barcode edits,
search submissions, suggestions, food-type choices and pagination cannot start
another request or update the closed view. Open pages keep these public tools
available during session verification and recovery; closing does not submit a
diary addition. In-flight reads retain their existing cancellation behavior.

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
