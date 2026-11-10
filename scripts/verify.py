#!/usr/bin/env python3
"""Checks a deployed Bail contract using only the chain and the public repository.

1. The contract account has no access keys. Bail has no method that deploys code or adds keys,
   so with no keys its code can never change.
2. Its code is exactly what the source builds to. The contract names its own source commit and
   build image (NEP-330); this rebuilds that commit in that image and compares the hashes.

Needs git, Docker and cargo-near. Standard library only.

    scripts/verify.py                    the contract in deployments/testnet.json
    scripts/verify.py v1.dontbail.testnet
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RPC = {
    "testnet": "https://archival-rpc.testnet.fastnear.com",
    "mainnet": "https://free.rpc.fastnear.com",
}
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


class RpcError(Exception):
    pass


def query(url, params):
    body = {"jsonrpc": "2.0", "id": "verify", "method": "query",
            "params": {"finality": "final", **params}}
    request = urllib.request.Request(url, json.dumps(body).encode(),
                                     {"Content-Type": "application/json"})
    for attempt in range(1, 7):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                reply = json.load(response)
            break
        except urllib.error.HTTPError as error:
            # Public endpoints throttle; wait as long as they ask, then try again.
            if error.code != 429 and error.code < 500 or attempt == 6:
                raise
            time.sleep(min(float(error.headers.get("Retry-After") or 0) or 2 * attempt, 10))
        except (urllib.error.URLError, TimeoutError):
            if attempt == 6:
                raise
            time.sleep(2 * attempt)
    error = reply.get("error") or reply.get("result", {}).get("error")
    if error:
        raise RpcError(error)
    return reply["result"]


def view(url, contract, method):
    result = query(url, {"request_type": "call_function", "account_id": contract,
                         "method_name": method, "args_base64": "e30="})
    return json.loads(bytes(result["result"]))


def b58(data):
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("contract", nargs="?")
    parser.add_argument("--network", choices=RPC, default="testnet")
    parser.add_argument("--rpc", help="RPC endpoint (default: NEAR_RPC, then the public one)")
    parser.add_argument("--repo", help="clone from here instead, such as a mirror or a local "
                        "checkout; the commit is still the one the contract names")
    args = parser.parse_args()
    sys.stdout.reconfigure(line_buffering=True)
    url = args.rpc or os.environ.get("NEAR_RPC") or RPC[args.network]
    contract = args.contract
    if not contract:
        record = ROOT / "deployments" / f"{args.network}.json"
        contract = json.loads(record.read_text())["contract"]

    failures = []

    def check(ok, passed, failed):
        print(f"{'PASS' if ok else 'FAIL'}  {passed if ok else failed}")
        if not ok:
            failures.append(failed)

    account = query(url, {"request_type": "view_account", "account_id": contract})
    keys = query(url, {"request_type": "view_access_key_list", "account_id": contract})["keys"]
    check(not keys, f"{contract} has no access keys, so its code can never change",
          f"{contract} still has {len(keys)} access key(s)")

    try:
        meta = view(url, contract, "contract_source_metadata")
    except RpcError:
        check(False, "", f"{contract} doesn't name its source (no NEP-330 metadata)")
        sys.exit(1)
    info = meta.get("build_info")
    if not info:
        check(False, "", f"{contract} names no reproducible build (NEP-330 build_info)")
        sys.exit(1)
    source = re.fullmatch(r"git\+(https://\S+?)\?rev=([0-9a-f]{40})", info["source_code_snapshot"])
    if not source:
        sys.exit(f"unexpected source_code_snapshot: {info['source_code_snapshot']}")
    repo, rev = source.groups()
    repo = args.repo or repo
    print(f"      source  {meta['link']}")
    print(f"      image   {info['build_environment']}")

    with tempfile.TemporaryDirectory(prefix="bail-verify-") as tmp:
        fetched = subprocess.run(["git", "clone", "--quiet", repo, tmp]).returncode == 0 and \
            subprocess.run(["git", "-C", tmp, "checkout", "--quiet", rev]).returncode == 0
        if not fetched:
            check(False, "", f"can't get commit {rev[:12]} from {repo}")
            sys.exit(1)
        manifest = Path(tmp, info["contract_path"], "Cargo.toml")
        subprocess.run(["cargo", "near", "build", "reproducible-wasm",
                        "--manifest-path", str(manifest)], check=True)
        built = Path(tmp, info["output_wasm_path"].removeprefix("/home/near/code/"))
        built_hash = b58(hashlib.sha256(built.read_bytes()).digest())
    check(built_hash == account["code_hash"],
          f"onchain code {account['code_hash']} is the rebuild of {rev[:12]}",
          f"onchain code {account['code_hash']} differs from the rebuild ({built_hash})")

    print(f"      config  {json.dumps(view(url, contract, 'get_config'))}")
    if failures:
        sys.exit(1)
    print(f"\n{contract} is locked and runs the published source.")


if __name__ == "__main__":
    try:
        main()
    except RpcError as error:
        sys.exit(f"RPC error: {error}")
