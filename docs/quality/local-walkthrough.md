# Reproduce the local product walkthrough

This opt-in command creates a separate synthetic account and catalogue for the
real web, API, PostgreSQL and Meilisearch path. It uses the application's existing
migrations, search projection, request schemas and account routes. It does not
start automatically through `pnpm dev`, CI or a machine restart.

The catalogue contains 12 explicitly labeled invented foods, 24 servings and all
15 core nutrient definitions. Account population creates seven profile-local days
with 42 diary entries, one recipe, manual goals, seven hydration entries and seven
weight readings. Unknown vitamin contributions remain unknown. These fixtures are
demonstration data, not dietary advice or accepted publisher/reviewer evidence.

## Prerequisites and creation

Run from a validated checkout in the WSL/Linux filesystem as the project user.
Use the installed Node, Python 3 with Linux pidfd support, and Docker Compose v2.
The Docker daemon must already be running and accessible through
`unix:///var/run/docker.sock`. The command never manages system services, changes
permissions/groups, installs dependencies, pulls images or reads the project `.env`.

Run the applicable normal validation and `pnpm build` before creation. The command
requires the API/package builds and Next standalone output. It records source HEAD,
working-tree status, diff digest, Node version and the web build ID. A fingerprint
of API/package output and the lockfile prevents restarting against changed builds;
after rebuilding, create a new runtime. This fingerprint does not establish that
a build came from the recorded source; the normal validation record does that.

The exact images in `scripts/local-walkthrough/compose.yaml` must already be cached:

- `postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94`
- `getmeili/meilisearch:v1.32.0@sha256:61b1c86c459fa52d0653516f573702791e611574737dc76175ae9d2628c911f5`

Obtain any missing prerequisite through the project's existing approval and
supply-chain workflow. Keeping these fixed pins is reproducibility evidence;
it is not a claim that their security review remains current.

```bash
mkdir -p "$HOME/.cache/nourishing-walkthrough"
python3 -B scripts/local-walkthrough/run.py create \
  --runtime-parent "$HOME/.cache/nourishing-walkthrough"
```

`create` is the explicit opt-in to start new local containers and applications and
populate their synthetic data. The default ports are web 3287, API 4287, PostgreSQL
55488 and Meilisearch 57788. Each is bound to `127.0.0.1`; an occupied port fails
without replacing its listener. Override them with `--web-port`, `--api-port`,
`--postgres-port` and `--meilisearch-port`. All four must differ.

Each container has 1 GiB memory with no additional swap, one CPU, 256 PIDs and
bounded Docker logs. A random project name and owner label distinguish its two
containers and persistent named volumes. Database passwords, search keys and
application keys are freshly generated. Only scoped search credentials reach
the seed helper or API.

The first output prints the private runtime directory. Keep that exact path:
commands never discover or adopt another walkthrough automatically. Runtime
directories are mode 0700 and private files mode 0600. The account's generated
email/password live in `walkthrough-account-credentials.json` there; open it
privately for normal browser sign-in. Do not paste credentials into a task,
terminal transcript, screenshot or Git. Session tokens remain in memory.

## Browser acceptance

Use a dedicated Brave task session. Open the printed login URL and sign in with
the private synthetic account. The API seed's successful report check establishes
population only; record actual browser results separately.

1. Open Today/Diary for the final date in `account-population.json`. Verify six
   saved entries and visible synthetic labels; note its starting energy total.
2. Use Add food to search for blueberries, choose 1.5 default servings and save
   to that date. The fixture is 60 kcal per 100 g and its serving is 150 g, so the
   daily energy should increase by exactly 135 kcal.
3. Edit that new entry to one serving. The increase over the starting total is
   now 90 kcal. Repeat it to the previous day; that day's increase is 90 kcal.
4. Open the seven-day report, inspect both days and their nutrient detail, and
   reload. Compare the exact saved values; missing vitamin D/B12 must remain
   explicit lower bounds where the selected foods omit those values.
5. Run `restart-apps` for this exact runtime, then reload the diary and report.
   Verify the two new entries and edited quantity persist through the real API
   and database. Record sign-in persistence and any visible error independently.
6. Check a narrow viewport, keyboard navigation and focus after editing. Save
   dated screenshots without credentials and record any remaining UI gaps.

Direct diary verification must use `limit=20` and follow continuation cursors
without combining revisions. The current web BFF supplies the strong correction
protocol for edits/deletes; do not reintroduce legacy requests in a test helper.

## Status, application restart and stop

Substitute the exact printed runtime directory for `/absolute/runtime`:

```bash
python3 -B scripts/local-walkthrough/run.py status --runtime /absolute/runtime
python3 -B scripts/local-walkthrough/run.py restart-apps --runtime /absolute/runtime
python3 -B scripts/local-walkthrough/run.py stop --runtime /absolute/runtime
```

`stop-apps` and `start-apps` are also available for a deliberate application-only
pause. `start-apps` requires the original containers to remain running; it does
not resume containers stopped by `stop`.

Before signaling, the command compares PID, start ticks, executable, working
directory, user and process group. It pins every group member with a Linux pidfd,
checks its inherited owner marker and uses SIGTERM with a 35-second grace period.
A changed identity, unowned member or surviving orphan group fails closed.
There is no force-kill. Container stop uses recorded full IDs and rechecks image,
name, labels, loopback ports and resource limits. Concurrent commands for one
runtime are rejected by a file lock.

`stop` retains named volumes, private runtime files and receipts. It never stops
the Docker engine, removes containers/volumes, searches for old PIDs or stops an
unrelated preview. Retained state can be inspected after failure. Deletion is a
separate explicit maintenance task; there is no automatic prune or reset.

Catalogue eligibility expires 12 hours after seeding. Restarting does not extend
it. Search/add may fail after expiry while saved diary snapshots remain. Create
a fresh runtime to repeat the demonstration; no re-seed or expiry-extension
operation is provided. Partial population is not automatically retried. Inspect
its private command/event receipts, stop the owned runtime, and create a new one.
If a container was created but identity capture failed, inspect the exact random
project printed in `runtime.json`; do not use broad cleanup commands.

## Offline checks and evidence limits

The normal `pnpm lint` and `pnpm check` commands also run the Python safety
suite through `scripts/local-walkthrough.test.mjs`. Missing Python, failed
tests, empty discovery and skipped tests fail the check. The suite stays
offline; it does not start the walkthrough. Run it directly when developing
the launcher:

```bash
python3 -B -m unittest discover -s scripts/local-walkthrough -p 'test_*.py' -v
node node_modules/tsx/dist/cli.mjs scripts/local-walkthrough/seed-catalogue.mts --validate-only
node scripts/local-walkthrough/populate-account.mjs --validate-only
```

The Python suite exercises replacement PIDs, foreign process-group members,
container identity drift, private state paths/permissions, concurrent operations,
ports and sanitized child environments. It mocks signals and performs no service
or network operations. The fixture validators use the installed application
definitions and contract schemas without connecting to services.

The scripts were extracted from the September 24 local walkthrough. Their
offline checks do not transfer that earlier browser/service result to a new
source tree. A fresh `create` and the browser journey above remain necessary
before calling this maintained entry point end-to-end verified. Catalogue
release, hosted deployment, signed-device and independent-review acceptance stay
under their existing release gates.
