#!/usr/bin/env python3
"""Prove OCI compat/native interoperability and least privilege without logging keys."""

import datetime
import hashlib
import hmac
import http.client
import json
import pathlib
import re
import secrets
import subprocess
import sys
import tempfile
import urllib.parse


def fail(message: str) -> None:
    raise SystemExit(message)


def read_created_key(path: pathlib.Path) -> dict[str, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))["data"]
        result = {"accessKeyId": data["id"], "secretAccessKey": data["key"]}
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        fail(f"Malformed OCI Customer Secret Key response at {path}: {error}")
    if not all(isinstance(value, str) and value for value in result.values()):
        fail(f"Missing OCI Customer Secret Key fields at {path}")
    return result


def encode(value: str, safe: str = "") -> str:
    return urllib.parse.quote(value, safe=safe, encoding="utf-8", errors="strict")


def signing_key(secret: str, date: str, region: str) -> bytes:
    date_key = hmac.new(("AWS4" + secret).encode(), date.encode(), hashlib.sha256).digest()
    region_key = hmac.new(date_key, region.encode(), hashlib.sha256).digest()
    service_key = hmac.new(region_key, b"s3", hashlib.sha256).digest()
    return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()


def s3_request(
    credential: dict[str, str],
    method: str,
    bucket: str,
    key: str | None = None,
    *,
    body: bytes = b"",
    query: tuple[tuple[str, str], ...] = (),
    expect_denied: bool = False,
    expect_status: int | None = None,
) -> tuple[bytes, http.client.HTTPMessage]:
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    short_date = now.strftime("%Y%m%d")
    canonical_uri = f"/{encode(bucket)}"
    if key is not None:
        canonical_uri += f"/{encode(key, safe='/~')}"
    canonical_query = "&".join(
        f"{encode(name)}={encode(value)}" for name, value in sorted(query)
    )
    payload_digest = hashlib.sha256(body).hexdigest()
    canonical_headers = (
        f"host:{endpoint_host}\n"
        f"x-amz-content-sha256:{payload_digest}\n"
        f"x-amz-date:{amz_date}\n"
    )
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical_request = "\n".join(
        (method, canonical_uri, canonical_query, canonical_headers, signed_headers, payload_digest)
    )
    scope = f"{short_date}/{region}/s3/aws4_request"
    string_to_sign = "\n".join(
        (
            "AWS4-HMAC-SHA256",
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode()).hexdigest(),
        )
    )
    signature = hmac.new(
        signing_key(credential["secretAccessKey"], short_date, region),
        string_to_sign.encode(),
        hashlib.sha256,
    ).hexdigest()
    authorization = (
        "AWS4-HMAC-SHA256 "
        f"Credential={credential['accessKeyId']}/{scope},"
        f"SignedHeaders={signed_headers},Signature={signature}"
    )
    target = canonical_uri + (f"?{canonical_query}" if canonical_query else "")
    connection = http.client.HTTPSConnection(endpoint_host, timeout=30)
    try:
        connection.request(
            method,
            target,
            body=body,
            headers={
                "Authorization": authorization,
                "Host": endpoint_host,
                "x-amz-content-sha256": payload_digest,
                "x-amz-date": amz_date,
            },
        )
        response = connection.getresponse()
        response_body = response.read(1_048_577)
        if len(response_body) > 1_048_576:
            fail("OCI S3 canary response exceeded 1 MiB")
        if expect_status is not None:
            if response.status != expect_status:
                fail(f"Expected HTTP {expect_status} but received HTTP {response.status}")
        elif expect_denied:
            if response.status not in {401, 403, 404}:
                fail(f"Expected authorization denial but received HTTP {response.status}")
        elif not 200 <= response.status < 300:
            fail(f"Required OCI S3 {method} canary failed with HTTP {response.status}")
        return response_body, response.headers
    finally:
        connection.close()


if len(sys.argv) != 13:
    fail(
        "Usage: object-storage-credential-canary.py <endpoint> <region> <namespace> "
        "<export-bucket> <ledger-bucket> <export-reader.json> <export-writer.json> "
        "<ledger-writer.json> <ledger-restore.json> <tenancy-ocid> <restore-user-ocid> "
        "<restore-api-response.json>"
    )

(
    endpoint,
    region,
    namespace,
    export_bucket,
    ledger_bucket,
    export_reader_path,
    export_writer_path,
    ledger_writer_path,
    ledger_restore_path,
    tenancy_ocid,
    restore_user_ocid,
    restore_api_response_path,
) = sys.argv[1:]

parsed_endpoint = urllib.parse.urlsplit(endpoint)
if (
    parsed_endpoint.scheme != "https"
    or parsed_endpoint.path not in {"", "/"}
    or parsed_endpoint.query
    or parsed_endpoint.fragment
    or parsed_endpoint.username
    or parsed_endpoint.password
    or parsed_endpoint.port is not None
    or not re.fullmatch(
        rf"{re.escape(namespace)}\.compat\.objectstorage\.{re.escape(region)}\.oci\.customer-oci\.com",
        parsed_endpoint.hostname or "",
    )
):
    fail("Canary endpoint must be the exact dedicated OCI S3 compatibility origin")
endpoint_host = parsed_endpoint.hostname

credentials = {
    "exportReader": read_created_key(pathlib.Path(export_reader_path)),
    "exportWriter": read_created_key(pathlib.Path(export_writer_path)),
    "ledgerWriter": read_created_key(pathlib.Path(ledger_writer_path)),
    "ledgerRestore": read_created_key(pathlib.Path(ledger_restore_path)),
}
private_key = pathlib.Path(restore_api_response_path).with_name("restore-private-key.pem")
try:
    fingerprint = json.loads(pathlib.Path(restore_api_response_path).read_text(encoding="utf-8"))["data"]["fingerprint"]
except (KeyError, TypeError, json.JSONDecodeError) as error:
    fail(f"Malformed OCI API-key upload response: {error}")

token = secrets.token_hex(12)
export_object = f"exports/v1/.credential-canary/{token}"
ledger_object = f"erasure-ledger/v1/.credential-canary/{token}"
payload = secrets.token_bytes(64)

# Export identities: known-key read, create/read/delete, no overwrite/list,
# no cross-bucket access, and no access outside the frozen object prefix.
s3_request(credentials["exportWriter"], "PUT", export_bucket, export_object, body=payload)
export_writer_body, _ = s3_request(credentials["exportWriter"], "GET", export_bucket, export_object)
export_reader_body, _ = s3_request(credentials["exportReader"], "GET", export_bucket, export_object)
if export_writer_body != payload or export_reader_body != payload:
    fail("Export S3 canary payload round-trip mismatch")
s3_request(credentials["exportReader"], "PUT", export_bucket, export_object, body=payload, expect_denied=True)
s3_request(credentials["exportReader"], "DELETE", export_bucket, export_object, expect_denied=True)
s3_request(credentials["exportWriter"], "PUT", export_bucket, export_object, body=payload, expect_denied=True)
s3_request(credentials["exportWriter"], "PUT", export_bucket, f"outside-reviewed-prefix/{token}", body=payload, expect_denied=True)
s3_request(credentials["exportWriter"], "GET", export_bucket, query=(("list-type", "2"), ("prefix", "exports/v1/")), expect_denied=True)

# Ledger writer is append/read-only. Restore can read the exact object but
# cannot write/delete or cross buckets. The canary remains as append-only audit
# evidence because no runtime principal has ledger delete permission.
_, put_headers = s3_request(credentials["ledgerWriter"], "PUT", ledger_bucket, ledger_object, body=payload)
compat_version = put_headers.get("x-amz-version-id")
if not isinstance(compat_version, str) or not re.fullmatch(r"[!-~]{1,1024}", compat_version):
    fail("Versioned compatibility PUT did not return a canonical x-amz-version-id")
ledger_writer_body, _ = s3_request(credentials["ledgerWriter"], "GET", ledger_bucket, ledger_object)
ledger_restore_body, _ = s3_request(credentials["ledgerRestore"], "GET", ledger_bucket, ledger_object)
if ledger_writer_body != payload or ledger_restore_body != payload:
    fail("Ledger S3 canary payload round-trip mismatch")
s3_request(credentials["ledgerWriter"], "PUT", ledger_bucket, ledger_object, body=payload, expect_denied=True)
s3_request(credentials["ledgerWriter"], "PUT", ledger_bucket, f"outside-reviewed-prefix/{token}", body=payload, expect_denied=True)
s3_request(credentials["ledgerWriter"], "DELETE", ledger_bucket, ledger_object, expect_denied=True)
s3_request(credentials["ledgerWriter"], "GET", ledger_bucket, query=(("list-type", "2"), ("prefix", "erasure-ledger/v1/")), expect_denied=True)
s3_request(credentials["ledgerRestore"], "PUT", ledger_bucket, ledger_object, body=payload, expect_denied=True)
s3_request(credentials["ledgerRestore"], "DELETE", ledger_bucket, ledger_object, expect_denied=True)
# Cross-bucket denials are tested only while both exact target objects exist,
# so a missing object cannot masquerade as a successful authorization gate.
s3_request(credentials["exportWriter"], "GET", ledger_bucket, ledger_object, expect_denied=True)
s3_request(credentials["ledgerRestore"], "GET", export_bucket, export_object, expect_denied=True)
s3_request(credentials["exportWriter"], "DELETE", export_bucket, export_object)
s3_request(credentials["exportWriter"], "GET", export_bucket, export_object, expect_status=404)

with tempfile.TemporaryDirectory(prefix="nutrition-native-oci-canary-") as temporary:
    oci_config = pathlib.Path(temporary) / "oci-config"
    oci_config.write_text(
        "[RESTORE_CANARY]\n"
        f"user={restore_user_ocid}\n"
        f"fingerprint={fingerprint}\n"
        f"tenancy={tenancy_ocid}\n"
        f"region={region}\n"
        f"key_file={private_key}\n",
        encoding="utf-8",
    )
    oci_config.chmod(0o600)
    try:
        native = subprocess.run(
            [
                "oci", "--config-file", str(oci_config), "--profile", "RESTORE_CANARY",
                "--auth", "api_key", "os", "object", "list-object-versions",
                "--namespace-name", namespace, "--bucket-name", ledger_bucket,
                "--prefix", ledger_object, "--all",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        fail("Native OCI ListObjectVersions canary timed out")
if native.returncode != 0:
    fail("Native OCI ListObjectVersions canary failed")
try:
    native_data = json.loads(native.stdout)["data"]
    native_items = native_data["items"]
except (KeyError, TypeError, json.JSONDecodeError) as error:
    fail(f"Native OCI ListObjectVersions returned an invalid schema: {error}")
if native_data.get("prefixes") not in (None, []) or len(native_items) != 1:
    fail("Native OCI ListObjectVersions did not return exactly one complete object version")
native_item = native_items[0]
native_version = native_item.get("version-id") if isinstance(native_item, dict) else None
if (
    not isinstance(native_item, dict)
    or native_item.get("name") != ledger_object
    or native_item.get("is-delete-marker") is not False
    or not isinstance(native_version, str)
    or not re.fullmatch(r"[!-~]{1,1024}", native_version)
):
    fail("Native OCI ListObjectVersions returned a wrong, deleted, or invalid version")
if compat_version != native_version:
    fail("Compatibility PUT and native inventory returned different version IDs")

versioned_body, versioned_headers = s3_request(
    credentials["ledgerRestore"],
    "GET",
    ledger_bucket,
    ledger_object,
    query=(("versionId", native_version),),
)
if versioned_body != payload or versioned_headers.get("x-amz-version-id") != native_version:
    fail("Exact-version S3 GET did not match the native OCI inventory version and payload")

print("OCI Object Storage allow/deny and compat/native version canaries passed; the append-only ledger canary was retained.")
