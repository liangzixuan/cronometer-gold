import hashlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch
import zipfile

path = Path(__file__).resolve().parents[1] / 'vendor.py'
if not path.exists():
    path = Path(__file__).with_name('browserstack-vendor.py')
spec = importlib.util.spec_from_file_location('browserstack_vendor', path)
vendor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vendor)


def fixture(extra=False, name='BrowserStackLocal', machine=183):
    data = bytearray(100)
    data[:7] = b'\x7fELF\x02\x01\x01'
    data[18:20] = machine.to_bytes(2, 'little')
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as archive:
        archive.writestr(name, data)
        if extra:
            archive.writestr('extra', b'unexpected')
    archive = stream.getvalue()
    config = {'url': vendor.URL, 'archiveSha256': hashlib.sha256(archive).hexdigest(),
              'binarySha256': hashlib.sha256(data).hexdigest(), 'archiveBytes': len(archive),
              'binaryBytes': len(data), 'version': '8.9', 'architecture': 'arm64'}
    return config, archive, bytes(data)


class VendorTests(unittest.TestCase):
    def test_exact_reviewed_archive_extracts(self):
        config, archive, data = fixture()
        self.assertEqual(vendor.extract_binary(config, archive), data)

    def test_wrong_hash_size_architecture_or_layout_fails(self):
        config, archive, _ = fixture()
        for field, value in [('archiveSha256', '0' * 64), ('binarySha256', '0' * 64),
                             ('archiveBytes', len(archive) + 1), ('binaryBytes', 101)]:
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                vendor.extract_binary({**config, field: value}, archive)
        for args in ({'extra': True}, {'name': '../BrowserStackLocal'}, {'machine': 62}):
            modified, blob, _ = fixture(**args)
            with self.subTest(args=args), self.assertRaises(RuntimeError):
                vendor.extract_binary(modified, blob)

    def test_unreviewed_url_cannot_issue_request(self):
        config, _, _ = fixture()
        for url in [vendor.URL + '?token=x', vendor.URL + '#fragment', vendor.URL.replace('https:', 'http:'),
                    vendor.URL.replace('local-downloads.browserstack.com', 'local-downloads.browserstack.com.evil.invalid'),
                    vendor.URL.replace('https://', 'https://user:secret@')]:
            with self.subTest(url=url), patch.object(vendor.urllib.request, 'build_opener') as opener:
                with self.assertRaises(RuntimeError):
                    vendor.read_archive({**config, 'url': url})
                opener.assert_not_called()

    def test_redirects_fail_closed(self):
        with self.assertRaises(RuntimeError):
            vendor.NoRedirect().redirect_request(None, None, 302, '', {}, vendor.URL)

    def test_native_version_and_options_required(self):
        config, _, _ = fixture()
        help_text = '\n'.join(vendor.FLAGS)
        vendor.validate_native_output('BrowserStack Local version 8.9\n', help_text, config)
        with self.assertRaises(RuntimeError):
            vendor.validate_native_output('BrowserStack Local version 9.0', help_text, config)
        for flag in vendor.FLAGS:
            with self.subTest(flag=flag), self.assertRaises(RuntimeError):
                vendor.validate_native_output('BrowserStack Local version 8.9', help_text.replace(flag, ''), config)


if __name__ == '__main__':
    unittest.main()
