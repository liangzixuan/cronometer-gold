#!/usr/bin/env python3
"""Bounded browser checks on a trusted ephemeral GitHub runner."""
import hashlib
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
import platform
import vendor

ROOT = Path(__file__).resolve().parents[2]  # After copying to scripts/browserstack.
CONFIG = Path(__file__).with_name('project.json')
ACTION = sys.argv[1] if len(sys.argv) == 2 else ''
BUILD_COMMAND = ('pnpm', 'exec', 'turbo', 'run', 'build',
                 '--filter=@nutrition-tracker/web...', '--filter=@nutrition-tracker/api...',
                 '--filter=@nutrition-tracker/worker...', '--force')
BUILD_OUTPUT_ROOTS = ('apps/api/dist', 'apps/worker/dist', 'packages/artifact-store/dist',
                      'packages/contracts/dist', 'packages/db/dist', 'packages/domain/dist',
                      'packages/search/dist', 'apps/web/.next/standalone', 'apps/web/.next/static')
CHECKS = ['authenticated-session-persistence', 'real-search-and-single-add',
          'saved-diary-entry-after-reload', 'report-agrees-with-saved-day', 'narrow-diary-remains-usable']
SEARCH_SUBSTEPS = frozenset(('open-foods', 'wait-destination', 'check-local-day', 'check-meal',
                             'fill-search', 'submit-search', 'wait-result', 'check-result-count',
                             'fill-amount', 'observe-add-response', 'click-add', 'check-add-response'))
COMMAND_STAGES = frozenset(('local-version', 'local-help', 'image-pull-0', 'image-pull-1',
                          'image-index-0', 'image-index-1', 'image-buildkit-0', 'image-buildkit-1',
                          'image-signed-provenance-0', 'image-signed-provenance-1',
                          'image-labels-0', 'image-labels-1', 'create', 'tunnel-start',
                          'browser', 'tunnel-stop', 'runtime-stop'))
CAPTURE = {'video': False, 'screenshots': False, 'networkLogs': False, 'console': 'disable',
           'playwrightLogs': False, 'maskCommands': 'sendType,sendPress,setHTTPCredentials,setStorageState,setGeolocation'}
os.umask(0o077)

def require(value, label):
    if not value:
        raise RuntimeError(label)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def save(path, value):
    with path.open('x', encoding='utf-8') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')

def read(path):
    require(path.is_file() and not path.is_symlink(), 'Expected regular private file')
    require(path.stat().st_size <= 2 * 1024 * 1024, 'Oversized private metadata')
    return json.loads(path.read_text())

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, timeout=20).decode().strip()

def source():
    require(git('status', '--porcelain') == '', 'Checkout changed or has untracked files')
    require(git('rev-parse', 'HEAD') == os.environ['GITHUB_SHA'], 'Wrong checkout SHA')
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT, timeout=20).decode().split('\0')
    entries = []
    for name in sorted(filter(None, paths)):
        path = ROOT / name
        require(path.is_file() and not path.is_symlink(), 'Unexpected tracked file kind')
        entries.append([name, sha(path.read_bytes()), stat.S_IMODE(path.stat().st_mode)])
    return {'sha': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}'),
            'trackedFiles': len(entries), 'fileMapSha256': sha(json.dumps(entries, separators=(',', ':')).encode()),
            'lockSha256': sha((ROOT / 'pnpm-lock.yaml').read_bytes())}

def command(label, argv, seconds, env=None):
    # Output stays in private files. Error/capability strings never reach CI logs.
    require(type(label) is str and label in COMMAND_STAGES, 'Unknown command stage')
    print(json.dumps({'stage': label, 'status': 'started'}), flush=True)
    out, err = PRIVATE / f'{label}.stdout', PRIVATE / f'{label}.stderr'
    with out.open('xb') as stdout, err.open('xb') as stderr:
        process = subprocess.Popen(argv, cwd=ROOT, stdout=stdout, stderr=stderr,
                                   stdin=subprocess.DEVNULL, env=env, start_new_session=True)
        def interrupted(signum, frame):
            raise RuntimeError(label + ': cancelled')
        previous_handler = signal.signal(signal.SIGTERM, interrupted)
        try:
            deadline = time.monotonic() + seconds
            while process.poll() is None:
                local_log = PRIVATE / 'local-private.log'
                log_size = local_log.stat().st_size if local_log.exists() else 0
                if time.monotonic() >= deadline or out.stat().st_size + err.stat().st_size + log_size > 8 * 1024 * 1024:
                    raise subprocess.TimeoutExpired(argv[0], seconds)
                time.sleep(0.1)
            code = process.returncode
        except BaseException:
            # This fresh child is the session/group leader. It has not been reaped;
            # its group ID cannot be reused while we signal its inherited children.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                raise RuntimeError(label + ': child did not terminate; ephemeral runner teardown required')
            raise RuntimeError(label + ': interrupted or timed out') from None
        finally:
            signal.signal(signal.SIGTERM, previous_handler)
    require(out.stat().st_size + err.stat().st_size <= 8 * 1024 * 1024, label + ': output exceeded review bound')
    require(code == 0, label + ': command failed')
    print(json.dumps({'stage': label, 'status': 'passed'}), flush=True)
    return out

def private_env():
    # Keep service setup free of BrowserStack credentials/SDK and proxy overrides.
    return {key: value for key, value in os.environ.items()
            if not re.match(r'(?i)^(BROWSERSTACK|PERCY|DEBUG|PWDEBUG|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)', key)}

def runtime_path():
    path = Path((PRIVATE / 'runtime-path').read_text().strip())
    require(path.parent == PRIVATE / 'runtimes' and path.name.startswith('nourishing-walkthrough-'), 'Unexpected runtime')
    require(path.resolve() == path and not path.is_symlink(), 'Runtime path changed')
    return path

def start_ticks(pid):
    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    return fields[19]

def owned_pid(pid, expected=None):
    require(type(pid) is int and pid > 1, 'Invalid tunnel PID')
    proc = Path(f'/proc/{pid}')
    value = {'pid': pid, 'uid': proc.stat().st_uid, 'startTicks': start_ticks(pid),
             'exe': str((proc / 'exe').resolve())}
    require(value['uid'] == os.getuid() and value['exe'] == str(PRIVATE / 'BrowserStackLocal'), 'Unowned tunnel PID')
    if expected is not None:
        require(value == expected, 'Tunnel process identity changed')
    return value

def prepare():
    require(CFG['status'] == 'reviewed-ready-for-first-run', 'Draft is not activated')
    require(CFG['repository'] == os.environ['GITHUB_REPOSITORY'] and CFG['branch'] == os.environ['GITHUB_REF'], 'Untrusted repository/ref')
    require(CFG['origin'] == 'http://127.0.0.1:3287' and CFG['localOnly'] == '127.0.0.1,3287,0', 'Tunnel scope changed')
    require(CFG['sessions'] == 1 and CFG['retries'] == 0, 'Session bound changed')
    require(CFG['imageProfile'] == 'ci-qualified-arm64' and len(CFG['images']) == 2
            and all(pin in (ROOT / 'scripts/local-walkthrough/run.py').read_text()
                    for pin in CFG['images']), 'Scanned images differ from launcher profile')
    PRIVATE.mkdir(mode=0o700)
    (PRIVATE / 'runtimes').mkdir(mode=0o700)
    save(PRIVATE / 'source-before.json', source())
    save(PRIVATE / 'local-binary.json', vendor.install(CFG['localBinary'], PRIVATE, command, private_env()))
    for index, pin in enumerate(CFG['images']):
        require(re.fullmatch(r'[a-z0-9/:.-]+@sha256:[a-f0-9]{64}', pin), 'Unpinned image')
        command(f'image-pull-{index}', ['docker', '--host', 'unix:///var/run/docker.sock', 'pull', '--platform', 'linux/arm64', pin], 300, private_env())


def admit_images():
    producers = CFG['imageProducers']
    require(type(producers) is list and len(producers) == 2
            and [item.get('image') for item in producers] == CFG['images'], 'Image provenance set differs')
    for index, item in enumerate(producers):
        require(set(item) == {'image', 'sourceSha', 'workflowSha', 'sourceRef'}
                and all(re.fullmatch('[a-f0-9]{40}', item[key]) for key in ('sourceSha', 'workflowSha'))
                and item['sourceRef'] == CFG['branch'], 'Invalid original image provenance')
        manifest = command(f'image-index-{index}', ['docker', 'buildx', 'imagetools', 'inspect',
                           '--raw', item['image']], 60, private_env())
        command(f'image-buildkit-{index}', ['node', 'scripts/verify-oci-buildkit-attestations.mjs',
                '--index', str(manifest), '--image-ref', item['image']], 180, private_env())
        command(f'image-signed-provenance-{index}', ['gh', 'attestation', 'verify', 'oci://' + item['image'],
                '--repo', CFG['repository'], '--signer-workflow', CFG['repository'] + '/.github/workflows/container-supply-chain.yml',
                '--signer-digest', item['workflowSha'], '--source-digest', item['sourceSha'],
                '--source-ref', item['sourceRef'], '--predicate-type', 'https://slsa.dev/provenance/v1',
                '--deny-self-hosted-runners'], 180, private_env())
        inspected = read(command(f'image-labels-{index}', ['docker', 'image', 'inspect', item['image']],
                                 60, private_env()))
        require(type(inspected) is list and len(inspected) == 1 and type(inspected[0]) is dict,
                'Unexpected image inspection result')
        image = inspected[0]
        require((image.get('Os'), image.get('Architecture')) == ('linux', 'arm64')
                and type(image.get('RepoDigests')) is list and item['image'] in image['RepoDigests']
                and type(image.get('Config')) is dict, 'Pulled image identity differs')
        spec = importlib.util.spec_from_file_location('repository_image_admission', ROOT / 'infra/oci/files/image-admission.py')
        policy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(policy)
        variables = [variable for variable, (repository, _component) in policy.REPOSITORY_IMAGES.items()
                     if item['image'].split('@', 1)[0] == repository]
        require(len(variables) == 1 and variables[0] in ('POSTGRES_IMAGE', 'MEILI_IMAGE'), 'Unexpected fixture image repository')
        try:
            policy.require_repository_source_contract(variables[0], image['Config'], item['sourceSha'])
        except SystemExit as error:
            raise RuntimeError('Image source identity differs from its original producer') from error
        try:
            policy.require_repository_runtime_contract(variables[0], image['Config'])
        except SystemExit as error:
            raise RuntimeError('Image runtime contract differs from the reviewed fixture policy') from error
    save(PRIVATE / 'image-provenance.json', {'images': producers, 'buildkitVerified': True,
         'githubSignedProvenanceVerified': True, 'runtimeImageIdentityVerified': True, 'runtimeContractVerified': True, 'runtimeStarted': False})


def build_outputs_sha256():
    files = []
    for relative in BUILD_OUTPUT_ROOTS:
        root = ROOT / relative
        require(root.is_dir() and not root.is_symlink(), 'Missing build output')
        entries = [[str(path.relative_to(ROOT)), sha(path.read_bytes())]
                   for path in sorted(root.rglob('*')) if path.is_file() and not path.is_symlink()]
        require(entries, 'Missing build output')
        files.extend(entries)
    return sha(json.dumps(files, separators=(',', ':')).encode())


def record_build():
    before = read(PRIVATE / 'source-before.json')
    require(source() == before, 'Build source changed')
    build_id = (ROOT / 'apps/web/.next/BUILD_ID').read_text().strip()
    require(bool(re.fullmatch('[a-zA-Z0-9_-]{1,100}', build_id)), 'Invalid Next build ID')
    save(PRIVATE / 'build.json', {**before, 'buildId': build_id, 'command': ' '.join(BUILD_COMMAND),
         'outputsSha256': build_outputs_sha256(),
         'nodeVersion': subprocess.check_output(['node', '--version']).decode().strip(),
         'pnpmVersion': subprocess.check_output(['pnpm', '--version']).decode().strip()})


STARTUP_PHASES = ('dependencies', 'migrate', 'scoped-keys', 'catalogue', 'account')
STARTUP_GUARDS = {
    'Expected two owned containers.': 'container-count',
    'Created container does not match the pinned, bounded local contract.': 'container-contract',
    'Container scratch mount differs from its profile.': 'container-scratch-contract',
    'CI container user differs from its admitted image.': 'container-user-contract',
    'Readiness failed at the selected loopback service.': 'application-readiness',
    'api exited or did not acquire the expected identity.': 'api-process-identity',
    'web exited or did not acquire the expected identity.': 'web-process-identity',
    'FileNotFoundError': 'filesystem-missing',
    'PermissionError': 'filesystem-permission',
    **{phase + ' failed; inspect its private log.': 'command-failed' for phase in STARTUP_PHASES},
}


def unavailable_startup():
    return {'diagnostics': 'unavailable', 'runtimeCreated': False, 'commands': [], 'guardCode': 'undisclosed'}


def diagnostic_text(path):
    # Read only a bounded owner-private regular receipt, never a child command log.
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and before.st_uid == os.getuid() and stat.S_IMODE(before.st_mode) == 0o600
                and 0 < before.st_size <= 65_536, 'Invalid diagnostic receipt')
        data = stream.read(65_537)
        after = os.fstat(stream.fileno())
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                and len(data) == before.st_size, 'Diagnostic receipt changed')
    return data.decode('utf-8')


def startup_diagnostic():
    try:
        path = Path(diagnostic_text(PRIVATE / 'runtime-path').strip())
        require(path.parent == PRIVATE / 'runtimes' and path.name.startswith('nourishing-walkthrough-')
                and path.resolve() == path and not path.is_symlink(), 'Invalid diagnostic runtime')
        metadata = path.stat()
        require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == os.getuid()
                and stat.S_IMODE(metadata.st_mode) == 0o700, 'Invalid diagnostic runtime owner')
        state = json.loads(diagnostic_text(path / 'runtime.json'))
        require(type(state) is dict and state.get('version') == 2 and state.get('syntheticOnly') is True
                and state.get('runtime') == str(path) and state.get('repository') == str(ROOT)
                and state.get('head') == os.environ['GITHUB_SHA'], 'Diagnostic runtime identity differs')
        commands = []
        for phase in STARTUP_PHASES:
            candidates = list(path.glob(phase + '-????????.json'))
            require(len(candidates) <= 1, 'Duplicate command receipt')
            if not candidates:
                continue
            receipt = candidates[0]
            require(re.fullmatch(phase + r'-[a-f0-9]{8}\.json', receipt.name), 'Invalid command receipt name')
            value = json.loads(diagnostic_text(receipt))
            require(type(value) is dict and value.get('label') == phase, 'Invalid command receipt label')
            code = value.get('exit')
            require('exit' in value and (code is None or type(code) is int and -64 <= code <= 255), 'Invalid command exit')
            stamps = []
            for key in ('startedAt', 'endedAt'):
                stamp = value.get(key)
                require(type(stamp) is str and len(stamp) <= 40, 'Invalid diagnostic timestamp')
                parsed = datetime.datetime.fromisoformat(stamp)
                require(parsed.utcoffset() == datetime.timedelta(0), 'Diagnostic timestamp must use UTC')
                stamps.append(parsed)
            elapsed = (stamps[1] - stamps[0]).total_seconds()
            require(0 <= elapsed <= 600, 'Invalid diagnostic duration')
            commands.append({'phase': phase, 'exit': code,
                'status': 'incomplete' if code is None else 'completed' if code == 0 else 'failed',
                'elapsedMilliseconds': int(elapsed * 1000)})
        require([item['phase'] for item in commands] == list(STARTUP_PHASES[:len(commands)])
                and all(item['exit'] == 0 for item in commands[:-1]), 'Inconsistent command sequence')
        guard = 'undisclosed'
        error_path = PRIVATE / 'create.stderr'
        if error_path.exists():
            error = json.loads(diagnostic_text(error_path))
            if type(error) is dict and error.get('failed') is True and type(error.get('reason')) is str:
                guard = STARTUP_GUARDS.get(error['reason'], 'undisclosed')
        return {'diagnostics': 'available', 'runtimeCreated': True, 'commands': commands, 'guardCode': guard}
    except Exception:
        return unavailable_startup()


def startup_cleanup_diagnostic():
    try:
        value = read(PRIVATE / 'cleanup.json')
        require(type(value) is dict and type(value.get('failures')) is list
                and all(type(item) is str and item in ('normal-tunnel-stop', 'owned-tunnel-cleanup', 'owned-runtime-cleanup')
                        for item in value['failures']), 'Invalid cleanup diagnostics')
        status = value.get('runtimeStop')
        require(type(status) is str and status in ('not-attempted', 'passed', 'failed')
                and (status == 'failed') == ('owned-runtime-cleanup' in value['failures']), 'Invalid runtime-stop result')
        return {'runtimeStop': status}
    except Exception:
        return {'runtimeStop': 'undisclosed'}


def start():
    try:
        _start_runtime()
    except Exception:
        # Recording failure must never replace the primary startup exception.
        try:
            save(PRIVATE / 'startup-failure.json', {'failed': True})
        except Exception:
            pass
        try:
            diagnostic = startup_diagnostic()
        except Exception:
            diagnostic = unavailable_startup()
        print(json.dumps({'startupFailure': diagnostic}), flush=True)
        raise


def _start_runtime():
    admitted = read(PRIVATE / 'image-provenance.json')
    require(admitted == {'images': CFG['imageProducers'], 'buildkitVerified': True,
            'githubSignedProvenanceVerified': True, 'runtimeImageIdentityVerified': True, 'runtimeContractVerified': True, 'runtimeStarted': False}, 'Image provenance admission missing')
    build = read(PRIVATE / 'build.json')
    require(build.get('command') == ' '.join(BUILD_COMMAND), 'Build command/tool mismatch')
    require(build.get('outputsSha256') == build_outputs_sha256(), 'Build output changed')
    try:
        command('create', ['python3', '-B', 'scripts/local-walkthrough/run.py', 'create',
                '--runtime-parent', str(PRIVATE / 'runtimes'), '--image-profile', CFG['imageProfile']], 600, private_env())
    finally:
        # The first flushed create line is saved even if later population fails.
        output = PRIVATE / 'create.stdout'
        if output.exists():
            first = output.open().readline(4096)
            try:
                item = json.loads(first)
                path = Path(item['runtime'])
                require(item['syntheticOnly'] is True and path.parent == PRIVATE / 'runtimes', 'Wrong partial runtime')
                (PRIVATE / 'runtime-path').write_text(str(path) + '\n')
            except (KeyError, ValueError):
                pass
    runtime = runtime_path()
    metadata, account, build = read(runtime / 'runtime.json'), read(runtime / 'account-population.json'), read(PRIVATE / 'build.json')
    require(metadata['head'] == build['sha'] and metadata['buildId'] == build['buildId'] and metadata['status'] == '', 'Runtime/source mismatch')
    require(account['syntheticOnly'] is True and account['diaryEntries'] == 42 and account['days'] == 7, 'Incomplete synthetic population')
    save(PRIVATE / 'browser-input.json', {'sourceSha': build['sha'], 'buildId': build['buildId'],
         'runtime': str(runtime), 'origin': CFG['origin'], 'date': account['to'], 'from': account['from'],
         'localIdentifier': f"nourishing-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}"})

def run_browser():
    values = read(PRIVATE / 'browser-input.json')
    require(sha((PRIVATE / 'BrowserStackLocal').read_bytes()) == CFG['localBinary']['binarySha256'], 'Vendor binary changed')
    key = os.environ.get('BROWSERSTACK_ACCESS_KEY', '')
    require(key and os.environ.get('BROWSERSTACK_USERNAME'), 'BrowserStack secrets missing')
    # JSON strings are YAML scalars. Only the key is kept in this private config.
    config = PRIVATE / 'local-secret.yml'
    with config.open('x') as handle:
        handle.write('key: ' + json.dumps(key) + '\n')
    base = [str(PRIVATE / 'BrowserStackLocal'), '--config-file', str(config), '--local-identifier',
            values['localIdentifier'], '--only', CFG['localOnly'], '--only-automate',
            '--log-file', str(PRIVATE / 'local-private.log'), '--disable-dashboard',
            '--disable-proxy-discovery', '--enable-utc-logging']
    # No --force, --force-local, folder, proxy, public host, or localhost alias.
    output = command('tunnel-start', [*base, '--daemon', 'start'], 45, private_env())
    state = json.loads(output.read_text() or (PRIVATE / 'tunnel-start.stderr').read_text())
    require(state.get('state') == 'connected', 'Tunnel did not connect')
    save(PRIVATE / 'tunnel-process.json', owned_pid(state.get('pid')))
    env = {**private_env(), 'NOURISHING_BROWSER_PRIVATE': str(PRIVATE),
           'BROWSERSTACK_USERNAME': os.environ['BROWSERSTACK_USERNAME'], 'BROWSERSTACK_ACCESS_KEY': key}
    command('browser', ['node', 'scripts/browserstack/smoke.mjs'], 240, env)

def cleanup():
    failures = []
    runtime_stop = 'not-attempted'
    config = PRIVATE / 'local-secret.yml'
    if config.exists():
        try:
            require(sha((PRIVATE / 'BrowserStackLocal').read_bytes()) == CFG['localBinary']['binarySha256'], 'Vendor binary changed')
            values = read(PRIVATE / 'browser-input.json')
            command('tunnel-stop', [str(PRIVATE / 'BrowserStackLocal'), '--config-file', str(config),
                    '--local-identifier', values['localIdentifier'], '--daemon', 'stop'], 30, private_env())
        except Exception:
            failures.append('normal-tunnel-stop')
    record = PRIVATE / 'tunnel-process.json'
    if record.exists():
        expected = read(record)
        try:
            owned_pid(expected['pid'], expected)
            descriptor = os.pidfd_open(expected['pid'])
            try:
                owned_pid(expected['pid'], expected)
                signal.pidfd_send_signal(descriptor, signal.SIGTERM)
            finally:
                os.close(descriptor)
            deadline = time.monotonic() + 20
            while Path(f"/proc/{expected['pid']}").exists() and time.monotonic() < deadline:
                time.sleep(0.2)
            require(not Path(f"/proc/{expected['pid']}").exists(), 'Tunnel still running')
        except FileNotFoundError:
            pass
        except Exception:
            failures.append('owned-tunnel-cleanup')
    if (PRIVATE / 'runtime-path').exists():
        try:
            command('runtime-stop', ['python3', '-B', 'scripts/local-walkthrough/run.py', 'stop',
                    '--runtime', str(runtime_path())], 150, private_env())
            runtime_stop = 'passed'
        except Exception:
            runtime_stop = 'failed'
            failures.append('owned-runtime-cleanup')
    save(PRIVATE / 'cleanup.json', {'failures': failures, 'runtimeStop': runtime_stop, 'volumesRetainedUntilEphemeralRunnerTeardown': True})
    require(not failures, 'Cleanup failed; never count this run as accepted')

def summary():
    # Validate before projecting. Unknown properties and unvalidated strings never enter CI logs.
    result = {'kind': 'synthetic-browser-ci', 'qualificationOrReleaseAcceptance': False}
    result['accepted'] = False
    browser = None
    try:
        require(not (PRIVATE / 'startup-failure.json').exists(), 'Startup failed')
        build, browser, cleaned = (read(PRIVATE / name) for name in ('build.json', 'browser-result.json', 'cleanup.json'))
        before = read(PRIVATE / 'source-before.json')
        require(all(build.get(key) == before.get(key) for key in ('sha', 'tree', 'trackedFiles', 'fileMapSha256', 'lockSha256')), 'Build source differs')
        require(build.get('sha') == os.environ['GITHUB_SHA'] and re.fullmatch('[a-f0-9]{40}', build['sha']), 'Wrong source')
        require(re.fullmatch('[a-f0-9]{40}', build.get('tree', '')) is not None, 'Wrong tree')
        require(all(re.fullmatch('[a-f0-9]{64}', build.get(key, '')) for key in ('fileMapSha256', 'lockSha256', 'outputsSha256')), 'Missing source/build hashes')
        require(type(build.get('trackedFiles')) is int and build['trackedFiles'] > 0, 'Invalid file count')
        require(re.fullmatch('[a-zA-Z0-9_-]{1,100}', build.get('buildId', '')) is not None, 'Invalid build ID')
        require(build.get('command') == ' '.join(BUILD_COMMAND) and build.get('nodeVersion') == 'v22.23.2' and build.get('pnpmVersion') == '11.19.0', 'Build command/tool mismatch')
        require(type(browser.get('schemaVersion')) is int and browser['schemaVersion'] == 1 and browser.get('syntheticOnly') is True and browser.get('status') == 'passed', 'Browser not passed')
        require(browser.get('sourceSha') == build['sha'] and browser.get('buildId') == build['buildId'], 'Browser/build mismatch')
        require(browser.get('origin') == 'http://127.0.0.1:3287' and browser.get('checks') == CHECKS, 'Incomplete journey')
        require(type(browser.get('browserSessionsAttempted')) is int and browser['browserSessionsAttempted'] == 1 and type(browser.get('retries')) is int and browser['retries'] == 0, 'Invalid session bounds')
        require(isinstance(browser.get('sessionId'), str) and re.fullmatch('[a-zA-Z0-9-]{1,100}', browser['sessionId']), 'Missing session')
        require(isinstance(browser.get('browserVersion'), str) and re.fullmatch('[a-zA-Z0-9._-]{1,100}', browser['browserVersion']), 'Missing browser version')
        terminal = browser.get('terminal', {})
        require(isinstance(terminal, dict), 'Invalid terminal record')
        build_name = f"nourishing-{build['sha']}-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}"
        require(terminal.get('sessionId') == browser['sessionId'] and terminal.get('status') == 'passed' and terminal.get('browserstackStatus') == 'done', 'Session not completed successfully')
        require(terminal.get('buildName') == build_name and terminal.get('projectName') == 'Nourishing' and terminal.get('name') == 'synthetic-login-search-add-report', 'Wrong remote session')
        require(type(terminal.get('durationSeconds')) is int and 0 <= terminal['durationSeconds'] <= 240, 'Invalid remote duration')
        capture = browser.get('capture')
        require(isinstance(capture, dict) and capture.get('requested') == CAPTURE and capture.get('dashboardVerification') == 'pending-first-run-review', 'Missing capture policy/limits')
        artifacts = capture.get('observedArtifacts', {})
        artifact_keys = ('video_url', 'har_logs_url', 'browser_console_logs_url', 'playwright_logs_url')
        require(isinstance(artifacts, dict), 'Invalid capture record')
        require(set(artifacts) == set(artifact_keys) and all(value in ('missing', 'null', 'empty', 'present') for value in artifacts.values()), 'Invalid capture observation')
        require(browser.get('cookieAttributesIndependentlyInspected') is False, 'Unsupported cookie claim')
        require(cleaned.get('failures') == [] and cleaned.get('volumesRetainedUntilEphemeralRunnerTeardown') is True, 'Cleanup incomplete')
        result['build'] = {key: build[key] for key in ('sha', 'tree', 'fileMapSha256', 'lockSha256', 'outputsSha256', 'trackedFiles', 'buildId', 'command', 'nodeVersion', 'pnpmVersion')}
        result['browser'] = {key: browser[key] for key in ('sourceSha', 'buildId', 'status', 'sessionId', 'browserVersion', 'browserSessionsAttempted', 'retries', 'origin')}
        result['browser']['checks'] = CHECKS
        result['terminal'] = {key: terminal[key] for key in ('sessionId', 'status', 'browserstackStatus', 'durationSeconds', 'buildName', 'projectName', 'name')}
        result['capture'] = {'requested': CAPTURE, 'observedArtifacts': {key: artifacts[key] for key in artifact_keys}, 'dashboardVerification': 'pending-first-run-review'}
        result['cookieAttributesIndependentlyInspected'] = False
        result['cleanup'] = {'failures': [], 'volumesRetainedUntilEphemeralRunnerTeardown': True}
        result['accepted'] = True
    except (OSError, ValueError, KeyError, TypeError, RuntimeError):
        result = {'kind': 'synthetic-browser-ci', 'qualificationOrReleaseAcceptance': False, 'accepted': False}
        # A failed first run must still identify its created vendor session, without
        # printing an arbitrary receipt object or relying on a private artifact.
        if isinstance(browser, dict) and browser.get('sourceSha') == os.environ['GITHUB_SHA']:
            session_id = browser.get('sessionId')
            if isinstance(session_id, str) and re.fullmatch('[a-zA-Z0-9-]{1,100}', session_id):
                failed = {'sourceSha': os.environ['GITHUB_SHA'], 'sessionId': session_id}
                if browser.get('failedStage') in ['connect', 'session-identity', 'terminal-verification', *CHECKS]:
                    failed['stage'] = browser['failedStage']
                if browser.get('status') == 'failed' and browser.get('failedStage') == 'real-search-and-single-add':
                    substep = browser.get('failedSubstep')
                    if type(substep) is str and substep in SEARCH_SUBSTEPS:
                        failed['substep'] = substep
                remote = browser.get('terminal')
                if isinstance(remote, dict) and remote.get('sessionId') == session_id:
                    if (browser.get('status') == 'failed' and browser.get('failedStage') == 'terminal-verification'
                            and browser.get('terminalVerificationFailed') is True):
                        reason = browser.get('terminalFailureReason')
                        if type(reason) is str and reason in ('cancelled', 'duration-unavailable'):
                            failed['terminalReason'] = reason
                    if remote.get('status') in ('passed', 'failed', 'done', 'running', 'error', 'timeout'):
                        failed['remoteStatus'] = remote['status']
                    if remote.get('browserstackStatus') in ('done', 'running', 'error', 'failed', 'timeout'):
                        failed['remoteExecutionStatus'] = remote['browserstackStatus']
                result['failedBrowser'] = failed
    if (PRIVATE / 'startup-failure.json').exists():
        result['startupFailure'] = startup_diagnostic()
        result['startupCleanup'] = startup_cleanup_diagnostic()
    print(json.dumps(result, sort_keys=True))
    require(result['accepted'], 'Browser delivery incomplete')

try:
    require(sys.platform == 'linux' and os.getuid() != 0 and os.environ.get('GITHUB_ACTIONS') == 'true', 'Ephemeral non-root GitHub Linux runner required')
    require(os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'Self-hosted/user machine forbidden')
    require(platform.machine() in ('aarch64', 'arm64') and os.environ.get('RUNNER_ARCH') == 'ARM64', 'Native hosted ARM64 runner required')
    require(os.environ.get('GITHUB_REPOSITORY') == 'liangzixuan/cronometer-gold', 'Wrong repository')
    require(os.environ.get('GITHUB_REF') == 'refs/heads/codex/retention-features', 'Wrong trusted branch')
    require(os.environ.get('GITHUB_EVENT_NAME') in ('push', 'workflow_dispatch'), 'Unsupported event')
    temp = Path(os.environ['RUNNER_TEMP']).resolve()
    PRIVATE = temp / f"nourishing-browser-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}"
    CFG = read(CONFIG)
    require(ACTION in ('prepare', 'admit-images', 'record-build', 'start', 'run', 'cleanup', 'summary'), 'Unknown mode')
    if ACTION == 'prepare': prepare()
    elif ACTION == 'admit-images': admit_images()
    elif ACTION == 'record-build': record_build()
    elif ACTION == 'start': start()
    elif ACTION == 'run': run_browser()
    elif ACTION == 'cleanup':
        if PRIVATE.exists(): cleanup()
    else: summary()
except Exception:
    print('Nourishing browser CI failed at the selected stage; private output was not disclosed.', file=sys.stderr)
    sys.exit(1)
