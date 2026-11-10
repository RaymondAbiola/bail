#!/usr/bin/env bash
# Deploys Bail to a fresh versioned sub-account, initialises it, registers it with test USDC and
# deletes its only key, so nobody can ever change its code. Then checks the result with
# scripts/verify.py and writes deployments/<network>.json.
#
# Run it from a clean commit that is already pushed: the reproducible build records that commit
# in the contract (NEP-330), so anyone can rebuild it.
#
# Needs cargo-near, near-cli-rs, Docker and python3, and the parent account's key in near-cli's
# legacy keychain (~/.near-credentials). No private key is ever read or printed by this script.
#
#   scripts/deploy.sh [parent] [version]      defaults: dontbail.testnet v1
#
# NEAR_NETWORK, NEAR_RPC and BAIL_TOKEN override the network, its RPC endpoint and the token.
set -euo pipefail
shopt -s inherit_errexit

cd "$(dirname "$0")/.."

parent="${1:-dontbail.testnet}"
version="${2:-v1}"
contract="$version.$parent"
network="${NEAR_NETWORK:-testnet}"
case "$network" in
  testnet) default_rpc=https://archival-rpc.testnet.fastnear.com ;;
  mainnet) default_rpc=https://free.rpc.fastnear.com ;;
  *) default_rpc="" ;;
esac
rpc="${NEAR_RPC:-$default_rpc}"
[ -n "$rpc" ] || { echo "deploy: set NEAR_RPC for the $network network" >&2; exit 1; }
token="${BAIL_TOKEN:-3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af}" # Circle test USDC
# The code's storage (about 3.2 NEAR) plus headroom. Events prepay their own storage.
fund="4 NEAR"
# One-minute minimums so a whole event can be watched in minutes; organizers choose longer.
config='{"fee_bps":0,"fee_account":null,"min_window_ms":60000,"min_reveal_ms":60000,"min_dispute_ms":60000,"max_event_ms":2592000000,"intents_account":null}'
wasm=target/near/bail/bail.wasm
log=$(mktemp)
stage=checks

on_exit() {
  status=$?
  rm -f "$log"
  if [ "$status" -ne 0 ] && [ "$stage" = created ]; then
    echo "deploy: nothing is locked yet. To start over, remove $contract and run this again:" >&2
    echo "  near account delete-account $contract beneficiary $parent network-config $network sign-with-legacy-keychain send" >&2
  fi
}
trap on_exit EXIT

fail() { echo "deploy: $*" >&2; exit 1; }

query() {
  curl -sS --fail -m 30 "$rpc" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"finality\":\"optimistic\",$1}}"
}

account_exists() {
  query "\"request_type\":\"view_account\",\"account_id\":\"$1\"" | grep -q '"code_hash"'
}

# Runs a near-cli command and prints the transaction id it reports.
send() {
  near "$@" network-config "$network" sign-with-legacy-keychain send 2>&1 | tee "$log" >&2
  grep -oE 'Transaction ID: [1-9A-HJ-NP-Za-km-z]+' "$log" | tail -1 | cut -d' ' -f3
}

for tool in cargo-near near docker python3 git curl; do
  command -v "$tool" >/dev/null || fail "$tool is not installed"
done
[ -z "$(git status --porcelain)" ] || fail "commit or stash your changes first"
git fetch --quiet origin
[ -n "$(git branch -r --contains HEAD)" ] || fail "push this commit first; the contract will link to it"
account_exists "$parent" || fail "$parent does not exist on $network"
query "\"request_type\":\"view_account\",\"account_id\":\"$parent\"" |
  python3 -I -c 'import json, sys; sys.exit(int(json.load(sys.stdin)["result"]["amount"]) < 41 * 10**23)' ||
  fail "$parent needs at least 4.1 NEAR: $fund for $contract, the rest for gas and registration"
! account_exists "$contract" || fail "$contract already exists; deploy a new version instead"

echo "== Reproducible build of $(git rev-parse --short HEAD)"
cargo near build reproducible-wasm --manifest-path contracts/bail/Cargo.toml
code_hash=$(python3 -I -c '
import hashlib, sys
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
d = hashlib.sha256(open(sys.argv[1], "rb").read()).digest()
n, s = int.from_bytes(d, "big"), ""
while n:
    n, r = divmod(n, 58)
    s = A[r] + s
print("1" * (len(d) - len(d.lstrip(b"\0"))) + s)' "$wasm")

echo "== Creating $contract with $fund"
tx_create=$(send account create-account fund-myself "$contract" "$fund" \
  autogenerate-new-keypair save-to-legacy-keychain sign-as "$parent")
stage=created

echo "== Deploying and initialising in one transaction"
tx_deploy=$(send contract deploy "$contract" use-file "$wasm" \
  with-init-call new json-args "{\"config\":$config}" \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR')

echo "== Registering $contract with $token"
tx_register=$(send contract call-function as-transaction "$token" storage_deposit \
  json-args "{\"account_id\":\"$contract\",\"registration_only\":true}" \
  prepaid-gas '30.0 Tgas' attached-deposit '0.00125 NEAR' sign-as "$parent")

# Check everything before the point of no return.
onchain=$(query "\"request_type\":\"view_account\",\"account_id\":\"$contract\"" |
  python3 -I -c 'import json, sys; print(json.load(sys.stdin)["result"]["code_hash"])')
[ "$onchain" = "$code_hash" ] || fail "onchain code $onchain is not the build $code_hash; not locking"
view() {
  query "\"request_type\":\"call_function\",\"account_id\":\"$contract\",\"method_name\":\"$1\",\"args_base64\":\"e30=\"" |
    python3 -I -c 'import json, sys; print(json.dumps(json.loads(bytes(json.load(sys.stdin)["result"]["result"])), sort_keys=True))'
}
[ "$(view get_config)" = "$(python3 -I -c 'import json, sys; print(json.dumps(json.loads(sys.argv[1]), sort_keys=True))' "$config")" ] ||
  fail "the onchain config is not the one intended; not locking"
source_link=$(view contract_source_metadata | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["link"])')
keys=$(query "\"request_type\":\"view_access_key_list\",\"account_id\":\"$contract\"" |
  python3 -I -c 'import json, sys; print(" ".join(k["public_key"] for k in json.load(sys.stdin)["result"]["keys"]))')
[ "$(wc -w <<<"$keys")" -eq 1 ] || fail "expected one access key on $contract, found: $keys"

echo "== Locking: deleting $contract's only key"
tx_lock=$(send account delete-keys "$contract" public-keys "$keys")
stage=locked

mkdir -p deployments
python3 -I - "deployments/$network.json" "$network" "$contract" "$parent" "$token" "$code_hash" \
  "$source_link" "$config" "$tx_create" "$tx_deploy" "$tx_register" "$tx_lock" <<'EOF'
import json, sys
from datetime import datetime, timezone
path, network, contract, parent, token, code_hash, source, config, *txs = sys.argv[1:]
record = {
    "network": network,
    "contract": contract,
    "parent": parent,
    "source": source,
    "code_hash": code_hash,
    "config": json.loads(config),
    "token": token,
    "transactions": dict(zip(["create", "deploy", "register", "lock"], txs)),
    "locked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
with open(path, "w") as f:
    json.dump(record, f, indent=2)
    f.write("\n")
EOF
echo "wrote deployments/$network.json"

echo "== Verifying from scratch"
python3 -I scripts/verify.py --rpc "$rpc" "$contract"
if [ "$network" = testnet ]; then
  echo "Explorer: https://testnet.nearblocks.io/address/$contract"
fi
