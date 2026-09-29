"""Acquire the reviewed BrowserStack Local ARM64 artifact without credential access."""
import hashlib
import io
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request
import zipfile

URL = 'https://local-downloads.browserstack.com/BrowserStackLocal-linux-arm64.zip'
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_BINARY = 64 * 1024 * 1024
FLAGS = ('--config-file', '--daemon', '--local-identifier', '--only', '--only-automate',
         '--log-file', '--disable-dashboard', '--disable-proxy-discovery', '--enable-utc-logging')


def require(value, message):
    if not value:
        raise RuntimeError(message)


def validate_config(config):
    require(config.get('url') == URL, 'Unreviewed Local binary URL')
    for field in ('archiveSha256', 'binarySha256'):
        require(isinstance(config.get(field), str) and re.fullmatch('[a-f0-9]{64}', config[field]), 'Missing artifact hash')
    require(type(config.get('archiveBytes')) is int and 0 < config['archiveBytes'] <= MAX_ARCHIVE, 'Invalid archive size')
    require(type(config.get('binaryBytes')) is int and 64 <= config['binaryBytes'] <= MAX_BINARY, 'Invalid binary size')
    require(config.get('version') == '8.9' and config.get('architecture') == 'arm64', 'Unsupported Local runtime')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, target):
        raise RuntimeError('Local artifact redirects require review')


def read_archive(config):
    validate_config(config)
    # No credential or proxy inheritance. Only the reviewed public HTTPS asset.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(urllib.request.Request(URL), timeout=30) as response:
        require(response.status == 200 and response.url == URL, 'Unexpected artifact response')
        return response.read(MAX_ARCHIVE + 1)


def extract_binary(config, archive):
    validate_config(config)
    require(len(archive) == config['archiveBytes'] and hashlib.sha256(archive).hexdigest() == config['archiveSha256'], 'Local archive identity mismatch')
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        entries = zipped.infolist()
        require(len(entries) == 1 and entries[0].filename == 'BrowserStackLocal' and not entries[0].is_dir(), 'Unexpected Local archive layout')
        require(entries[0].file_size == config['binaryBytes'], 'Local binary size mismatch')
        data = zipped.read(entries[0])
    require(len(data) == config['binaryBytes'] and hashlib.sha256(data).hexdigest() == config['binarySha256'], 'Local binary identity mismatch')
    require(data[:7] == b'\x7fELF\x02\x01\x01' and int.from_bytes(data[18:20], 'little') == 183, 'Expected native ARM64 ELF')
    return data


def validate_native_output(version, help_text, config):
    require(version.strip() == 'BrowserStack Local version ' + config['version'], 'Unexpected native Local version')
    require(all(flag in help_text for flag in FLAGS), 'Native Local option missing')


def install(config, private, command, environment):
    data = extract_binary(config, read_archive(config))
    target = private / 'BrowserStackLocal'
    with target.open('xb') as stream:
        stream.write(data)
    target.chmod(0o700)
    version = command('local-version', [str(target), '--version'], 15, environment).read_text()
    help_text = command('local-help', [str(target), '--help'], 15, environment).read_text()
    validate_native_output(version, help_text, config)
    return {'architecture': 'arm64', 'version': config['version'],
            'archiveSha256': config['archiveSha256'], 'binarySha256': config['binarySha256'],
            'nativeVersionAndOptionsVerified': True}
