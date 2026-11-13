#!/usr/bin/env python3
"""Checks Bail's published testnet results against the chain, without trusting the contract's
own tally. Needs Python 3.10+ and the network. No keys, no install. Standard library only.

For each event it reads the raw data and recomputes:
  1. each revealed code against the commitment the host made when the code opened;
  2. each ticket's catches against the revealed codes, so it recounts who attended itself;
  3. the outcomes, the forfeit pool, the bonus and every payout, and compares all of it with
     the contract's tally and with the numbers in the README.
Then it checks the contract is locked, every payout was sent (or why not), and that event 6's
arbiter is a Sputnik DAO whose council voted to void it.

    python3 scripts/check-events.py
"""

import base64
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request

CONTRACT = "v1.dontbail.testnet"
ORGANIZER = "dontbail.testnet"
RPCS = ["https://rpc.testnet.fastnear.com", "https://archival-rpc.testnet.fastnear.com",
        "https://near-testnet.drpc.org"]
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
VOUCHES_NEEDED = 2

# What the README and docs/ say, so a mismatch with the chain fails loudly.
PUBLISHED = {
    4: {"name": "Dry run with friends, 11 Nov", "status": "Active", "seats": 4,
        "note": "The dry run's arbiter was the author's own relayer account. Event 5's is another person's account, and event 6's is a DAO the author can't act through alone.",
        "attended": 1, "vouched": 0, "forfeited": 3, "refunded": 0, "bonus": 1_500_000},
    5: {"name": "First event, a Google Meet call, 12 Nov", "status": "Active", "seats": 11,
        "attended": 6, "vouched": 0, "forfeited": 5, "refunded": 0, "bonus": 416_666},
    6: {"name": "Sputnik DAO arbiter demo, 13 Nov", "status": "Voided", "seats": 3,
        "attended": 0, "vouched": 0, "forfeited": 0, "refunded": 3, "bonus": 0},
}
DAO = "bail-arbiter.sputnikv2.testnet"
DAO_FACTORY = "sputnikv2.testnet"
COUNCIL = {"raymond-bail.testnet", "dolapo-bail.testnet"}
# A payout that failed for a reason the README states: the address was mistyped at RSVP.
KNOWN_UNPAID = {(5, "near:adetomiwa")}

failures = []


def check(ok, message):
    print(("  PASS  " if ok else "  FAIL  ") + message)
    if not ok:
        failures.append(message)
    return ok


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": "check", "method": method, "params": params}).encode()
    last = None
    for attempt in range(6):
        url = RPCS[attempt % len(RPCS)]
        try:
            request = urllib.request.Request(url, body, {"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=30) as response:
                reply = json.load(response)
        except (urllib.error.URLError, TimeoutError) as error:
            last = error
            time.sleep(1 + attempt)
            continue
        return reply
    raise SystemExit(f"Could not reach testnet RPC: {last}")


def view(contract, method, args=None):
    args64 = base64.b64encode(json.dumps(args or {}).encode()).decode()
    reply = rpc("query", {"request_type": "call_function", "finality": "final", "account_id": contract,
                          "method_name": method, "args_base64": args64})
    result = reply.get("result", {})
    if "error" in reply or "error" in result:
        raise SystemExit(f"{contract}.{method} failed: {reply.get('error') or result.get('error')}")
    return json.loads(bytes(result["result"]))


def account(account_id):
    reply = rpc("query", {"request_type": "view_account", "finality": "final", "account_id": account_id})
    return reply.get("result")


def b58decode(text):
    n = 0
    for c in text:
        n = n * 58 + B58.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\0" * (len(text) - len(text.lstrip("1"))) + raw


def b58encode(data):
    n, out = int.from_bytes(data, "big"), ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def fields(*parts):
    """Each field is its length as 4 little-endian bytes, then its bytes, as the contract hashes them."""
    return b"".join(len(p).to_bytes(4, "little") + p for p in parts)


def normalize(code):
    words = [w for w in re.split(r"[ \t\n\f\r]+", code) if w]
    return " ".join(re.sub(r"[A-Z]", lambda m: m.group().lower(), w) for w in words)


def commitment(event_id, slot, code):
    return hashlib.sha256(fields(b"bail/v1/code", CONTRACT.encode(), event_id.to_bytes(8, "little"),
                                 bytes([slot]), normalize(code).encode())).digest()


def catch_proof(event_id, slot, code, ticket_key):
    key = b58decode(ticket_key.removeprefix("ed25519:"))
    return hashlib.sha256(fields(b"bail/v1/proof", CONTRACT.encode(), event_id.to_bytes(8, "little"),
                                 bytes([slot]), normalize(code).encode(), key)).digest()


def all_tickets(event_id):
    tickets = []
    while True:
        page = view(CONTRACT, "get_tickets", {"event_id": event_id, "from": len(tickets), "limit": 50})
        tickets += page
        if len(page) < 50:
            return tickets


def usdc(units):
    return f"{units / 1_000_000:g}"


def check_contract():
    print(f"\nContract {CONTRACT}")
    keys = rpc("query", {"request_type": "view_access_key_list", "finality": "final",
                         "account_id": CONTRACT})["result"]["keys"]
    check(keys == [], "it has no access keys, so its code can never change (scripts/verify.py rebuilds it from source)")
    meta = view(CONTRACT, "contract_source_metadata")
    print(f"        source: {meta.get('link')}")
    return view(CONTRACT, "get_config")


def check_event(event_id, config):
    want = PUBLISHED[event_id]
    print(f"\nEvent {event_id}: {want['name']}")
    event = view(CONTRACT, "get_event", {"event_id": event_id})
    tally = event["tally"]
    deposit = int(event["deposit"])
    check(event["organizer"] == ORGANIZER and event["arbiter"] != ORGANIZER,
          f"organizer {event['organizer']}, arbiter {event['arbiter']} (not the organizer)")
    if "note" in want:
        print(f"        {want['note']}")
    check(event["status"] == want["status"] and tally and tally["stage"] == "Done",
          f"status {event['status']}, tally {tally and tally['stage']}")

    # 1. Every revealed code matches what the host committed to when it opened.
    revealed = {}
    for slot, s in enumerate(event["slots"]):
        if s["revealed"] is None:
            continue
        ok = base64.b64decode(s["commitment"]) == commitment(event_id, slot, s["revealed"])
        check(ok, f"code {slot + 1} \"{s['revealed']}\" matches the commitment made when it opened")
        revealed[slot] = s["revealed"]
    void = event["checkin"]["slots"] - len(revealed)
    needed = max(0, event["checkin"]["required"] - void)
    print(f"        {len(event['slots'])} of {event['checkin']['slots']} codes opened, {len(revealed)} revealed, "
          f"{void} void, so {needed} of {event['checkin']['required']} needed to attend")

    # 2. Recount attendance from the catch proofs, then 3. recompute outcomes and payouts.
    tickets = all_tickets(event_id)
    check(len(tickets) == event["registered"] == want["seats"], f"{len(tickets)} tickets, as published")
    refund_all = event["status"] in ("Cancelled", "Voided")
    counts = {"Attended": 0, "Vouched": 0, "Forfeited": 0, "Refunded": 0}
    outcomes = []
    for key, t in tickets:
        caught = sum(1 for slot, code in revealed.items()
                     if t["catches"][slot] and base64.b64decode(t["catches"][slot]["proof"]) == catch_proof(event_id, slot, code, key))
        outcome = ("Refunded" if refund_all else "Attended" if caught >= needed
                   else "Vouched" if t["vouched_by"] >= VOUCHES_NEEDED else "Forfeited")
        counts[outcome] += 1
        outcomes.append((key, t, caught, outcome))
    mismatched = [t["index"] + 1 for _, t, _, outcome in outcomes if t["outcome"] != outcome]
    check(not mismatched, "recounting every ticket's catches gives the outcome the contract recorded"
          + (f" (differs for #{mismatched})" if mismatched else ""))
    for name in ("attended", "vouched", "forfeited", "refunded"):
        check(counts[name.capitalize()] == tally[name] == want[name],
              f"{name}: recount {counts[name.capitalize()]}, contract {tally[name]}, published {want[name]}")

    everyone_refunded = counts["Refunded"] > 0 or counts["Attended"] == 0
    pool = 0 if everyone_refunded else counts["Forfeited"] * deposit
    fee = pool * config["fee_bps"] // 10_000
    bonus = 0 if everyone_refunded else (pool - fee) // counts["Attended"]
    check((int(tally["pool"]), int(tally["fee"]), int(tally["bonus"])) == (pool, fee, bonus) and bonus == want["bonus"],
          f"forfeit pool {usdc(pool)}, fee {usdc(fee)}, bonus {usdc(bonus)} per attendee, recomputed")

    unpaid = []
    for key, t, caught, outcome in outcomes:
        amount = deposit if everyone_refunded else {"Attended": deposit + bonus, "Vouched": deposit,
                                                    "Refunded": deposit, "Forfeited": 0}[outcome]
        if amount and not t["paid"]:
            unpaid.append((t, amount))
    known = [(t, a) for t, a in unpaid if (event_id, t["payout_to"]) in KNOWN_UNPAID]
    check(len(unpaid) == len(known), f"every payout was sent, except {len(known)} explained below" if known
          else "every payout was sent")
    for t, amount in known:
        exists = account(t["payout_to"].removeprefix("near:")) is not None
        check(not exists, f"#{t['index'] + 1}'s {usdc(amount)} wasn't sent because {t['payout_to']} doesn't exist "
              "(mistyped at RSVP); it stays held by the contract")
    return event


def check_dao(event):
    print(f"\nEvent 6's arbiter, the Sputnik DAO {DAO}")
    check(event["arbiter"] == DAO, f"event 6's arbiter is {event['arbiter']}")
    code_hash = account(DAO)["code_hash"]
    check(code_hash == view(DAO_FACTORY, "get_default_code_hash"),
          f"it runs the code {DAO_FACTORY} deploys for every DAO ({code_hash[:12]}...)")
    policy = view(DAO, "get_policy")
    council = next(set(r["kind"]["Group"]) for r in policy["roles"] if r["name"] == "council")
    check(council == COUNCIL and ORGANIZER not in council,
          f"council: {', '.join(sorted(council))}; the organizer is not on it")
    proposal = view(DAO, "get_proposal", {"id": 0})
    call = proposal["kind"].get("FunctionCall", {})
    action = (call.get("actions") or [{}])[0]
    args = json.loads(base64.b64decode(action.get("args", "e30=")))
    check(call.get("receiver_id") == CONTRACT and action.get("method_name") == "void_event"
          and args == {"event_id": 6} and action.get("deposit") == "1",
          "proposal 0 asks the DAO to call void_event on event 6 with 1 yoctoNEAR")
    votes = proposal["votes"]
    check(proposal["status"] == "Approved" and set(votes) == COUNCIL and set(votes.values()) == {"Approve"},
          f"it passed with both council votes: {', '.join(f'{k} {v}' for k, v in sorted(votes.items()))}")


def main():
    print("Checking Bail's published results against NEAR testnet. Nothing here needs a key.")
    config = check_contract()
    events = {event_id: check_event(event_id, config) for event_id in PUBLISHED}
    check_dao(events[6])
    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s) did not match the chain.")
        sys.exit(1)
    print("ALL CHECKS PASSED: the published results match the chain, recomputed independently.")


if __name__ == "__main__":
    main()
