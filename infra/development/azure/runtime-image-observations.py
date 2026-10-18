"""Validate captured local image observations using maintained backend contracts. No native actions."""
import json
import re
import runpy
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
MAXIMUM = 524288

def require(value):
    if not value:
        raise ValueError("captured runtime image contract failed")

def members(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result

def admit(value):
    require(type(value) is dict and set(value) == {"schema_version", "source_revision", "images", "observations"})
    require(type(value["schema_version"]) is int and value["schema_version"] == 1)
    revision = value["source_revision"]
    require(isinstance(revision, str) and re.fullmatch(r"[a-f0-9]{40}", revision))
    maintained = runpy.run_path(str(REPO / "infra/oci/files/image-admission.py"))
    expected = maintained["profile_images"]("appwrite-cloud-azure-v1")
    images, observations = value["images"], value["observations"]
    require(type(images) is dict and set(images) == set(expected))
    require(type(observations) is dict and set(observations) == set(images.values()))
    result = {}
    for name, (repository, _) in expected.items():
        reference = images[name]
        require(isinstance(reference, str) and maintained["REFERENCE"].fullmatch(reference) and reference.startswith(repository + "@"))
        row = observations[reference]
        require(type(row) is dict and row.get("Os") == "linux" and row.get("Architecture") == "arm64")
        identity = row.get("Id")
        require(isinstance(identity, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", identity))
        require(type(row.get("RepoDigests")) is list and reference in row["RepoDigests"])
        require(type(row.get("Config")) is dict)
        maintained["require_repository_source_contract"](name, row["Config"], revision)
        maintained["require_repository_runtime_contract"](name, row["Config"])
        result[name] = {"reference": reference, "image_id": identity}
    require(len({entry["image_id"] for entry in result.values()}) == 6)
    return {"kind": "nutrition-development-image-observations-v1", "source_revision": revision,
            "images": result, "localOnly": True, "operationalAcceptance": False, "provenanceQualified": False}

def main():
    try:
        require(len(sys.argv) == 1)
        raw = sys.stdin.buffer.read(MAXIMUM + 1)
        require(0 < len(raw) <= MAXIMUM)
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=members,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")))
        print(json.dumps(admit(value), sort_keys=True, separators=(",", ":")))
    except (Exception, SystemExit):
        print("Captured runtime image admission failed", file=sys.stderr)
        return 2
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
