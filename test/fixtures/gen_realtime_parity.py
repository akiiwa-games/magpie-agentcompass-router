"""Regenerate test/fixtures/agentcompass-realtime-parity.json with AgentCompass's own audit/gen_routing_parity.py at the pinned commit.

    python -X utf8 test/fixtures/gen_realtime_parity.py [--commit <sha>]

The test suite compares the JS port against this output, so it needs neither Python nor the checkout to run. Rerun after
moving the pin. AgentCompass is read through `git archive <commit>`, never a working tree. `pin_bundles` adds the bundles
of the reference accounts its `pins` rows route over.
"""
import argparse
import importlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PIN = json.load(open(os.path.join(HERE, "agentcompass-pin.json"), encoding="utf-8"))
parser = argparse.ArgumentParser()
parser.add_argument("--repo", default=os.environ.get("MAGPIE_AGENTCOMPASS_REPO", PIN["repo"]))
parser.add_argument("--commit", default=os.environ.get("MAGPIE_AGENTCOMPASS_COMMIT", PIN["commit"]))
args = parser.parse_args()

work = tempfile.mkdtemp(prefix="ac-parity-")
archive = subprocess.run(
    ["git", "-C", args.repo, "archive", "--format=tar", args.commit, "audit/gen_routing_parity.py"],
    check=True,
    capture_output=True,
).stdout
tarfile.open(fileobj=io.BytesIO(archive)).extractall(work, filter="data")
sys.path.insert(0, os.path.join(work, "audit"))
generator = importlib.import_module("gen_routing_parity")

pin_bundles = {}
build = generator.build


def build_with_bundles(allocator, auto_bundles, support, commit, root):
    fixture = allocator.load_accounts(root / generator.SCRIPTS / "fixtures/reference-accounts.json")
    pin_bundles.update(allocator.bundles(fixture))
    return build(allocator, auto_bundles, support, commit, root)


generator.build = build_with_bundles
result = generator.generate(args.commit, Path(args.repo))
result["pin_bundles"] = pin_bundles
path = os.path.join(HERE, "agentcompass-realtime-parity.json")
with open(path, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(result, fh, ensure_ascii=False, separators=(",", ":"))
print(f"{result['source']['commit']}: {len(result['stepdown'])} step-down rows -> {path}")
