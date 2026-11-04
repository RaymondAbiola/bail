//! Test vectors for the TypeScript SDK, built from the contract's own code.
//!
//! The file is committed at packages/sdk/test/vectors.json and checked both here and by
//! the SDK's tests, so neither side can drift. After a deliberate format change, rewrite
//! it with `BAIL_WRITE_VECTORS=1 cargo test -p bail --lib vectors`.

use super::*;

const VECTORS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/sdk/test/vectors.json"
);
const DEPLOYED: &str = "v1.dontbail.testnet";
const SEEDS: [u8; 3] = [1, 2, 0xa7];
const CODES: [(EventId, u8, &str); 4] = [
    (0, 0, "tiger maple seven ocean lamp"),
    (7, 2, "  TIGER maple\tSeven ocean LAMP"),
    (4_294_967_296, 4, "abandon ability able about above"),
    (9_007_199_254_740_991, 255, "zoo"),
];

fn on_testnet() {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(DEPLOYED))
        .build());
}

fn secret_key(seed: u8) -> String {
    let mut both = vec![seed; 32];
    both.extend_from_slice(&key_bytes(seed));
    format!("ed25519:{}", near_sdk::bs58::encode(both).into_string())
}

fn b64(bytes: &[u8]) -> Value {
    json!(Base64VecU8(bytes.to_vec()))
}

/// A signed action as the contract checks it: the signature must verify on its message.
fn signed(action: &str, seed: u8, message: String, fields: Value) -> Value {
    let signature = sign(seed, &message);
    assert!(verify_ticket(&key_bytes(seed), &message, &signature.0));
    let mut entry = json!({ "action": action, "ticket": ticket(seed), "message": message, "signature": signature });
    entry
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    entry
}

/// Deposits each note into a fresh event and records whether the contract seated it.
fn notes(intents: bool) -> Vec<Value> {
    ctx("deployer.near", NOW, NearToken::from_near(0));
    let mut c = Bail::new(Config {
        intents_account: intents.then(|| acc("intents.near")),
        ..config()
    });
    let id = create(&mut c, new_event(20));
    let implicit = format!("near:{}", "0a".repeat(32));
    let addresses = [
        "near:alice.testnet",
        implicit.as_str(),
        "near:a-b_c.d",
        "near:Alice.testnet",
        "near:a",
        "near:alice..testnet",
        "near:-alice.testnet",
        "intents:alice.near",
        "alice.testnet",
        "intents:Alice.near",
    ];
    addresses
        .iter()
        .zip(10u8..)
        .map(|(&payout_to, seed)| {
            let note = msg(id, seed, payout_to);
            let refunded = send(&mut c, USDC, NOW, DEPOSIT, note.clone());
            assert!(refunded == 0 || refunded == DEPOSIT);
            json!({
                "event_id": id, "ticket_key": ticket(seed), "payout_to": payout_to,
                "intents": intents, "note": note, "accepted": refunded == 0,
            })
        })
        .collect()
}

fn build() -> Value {
    let mut notes_all = notes(false);
    notes_all.extend(notes(true));

    on_testnet();
    let tickets: Vec<Value> = SEEDS
        .iter()
        .map(|&s| json!({ "seed_hex": to_hex(&[s; 32]), "public_key": ticket(s), "secret_key": secret_key(s) }))
        .collect();
    let normalize: Vec<Value> = [
        "  Tiger  MAPLE\tseven ocean LAMP ",
        "one\ntwo\r\nthree\x0cfour",
        "a\x0bb",
        "Élan VITAL",
        "   ",
        "",
    ]
    .iter()
    .map(|&input| json!({ "input": input, "output": normalize_code(input) }))
    .collect();

    let mut commitments = Vec::new();
    let mut proofs = Vec::new();
    let mut messages = Vec::new();
    for (i, &(event_id, slot, code)) in CODES.iter().enumerate() {
        let normalized = normalize_code(code);
        let seed = SEEDS[i % SEEDS.len()];
        let proof = catch_proof(event_id, slot, &normalized, &key_bytes(seed));
        commitments.push(json!({
            "event_id": event_id, "slot": slot, "code": code,
            "commitment": b64(&code_commitment(event_id, slot, &normalized)),
        }));
        proofs.push(json!({
            "event_id": event_id, "slot": slot, "code": code, "ticket": ticket(seed), "proof": b64(&proof),
        }));
        let attempt = 3 + i as u32;
        let message = signed_message(
            "catch",
            event_id,
            &[&slot.to_string(), &attempt.to_string(), &hex(&proof)],
        );
        messages.push(signed(
            "catch",
            seed,
            message,
            json!({ "event_id": event_id, "slot": slot, "attempt": attempt, "code": code, "proof": b64(&proof) }),
        ));
    }
    messages.push(signed(
        "flag",
        SEEDS[0],
        signed_message("flag", 7, &["1"]),
        json!({ "event_id": 7, "slot": 1 }),
    ));
    messages.push(signed(
        "cancel",
        SEEDS[1],
        signed_message("cancel", 7, &[]),
        json!({ "event_id": 7 }),
    ));
    messages.push(signed(
        "vouch",
        SEEDS[0],
        signed_message("vouch", 7, &[&ticket(SEEDS[2]).to_string()]),
        json!({ "event_id": 7, "target": ticket(SEEDS[2]) }),
    ));

    json!({
        "contract": DEPLOYED,
        "tickets": tickets,
        "normalize": normalize,
        "commitments": commitments,
        "proofs": proofs,
        "messages": messages,
        "notes": notes_all,
    })
}

#[test]
fn sdk_vectors_match_the_contract() {
    let expected = build();
    if std::env::var_os("BAIL_WRITE_VECTORS").is_some() {
        let text = near_sdk::serde_json::to_string_pretty(&expected).unwrap() + "\n";
        std::fs::write(VECTORS, text).unwrap();
        return;
    }
    let committed: Value = near_sdk::serde_json::from_str(
        &std::fs::read_to_string(VECTORS).expect("packages/sdk/test/vectors.json is missing"),
    )
    .unwrap();
    assert!(
        committed == expected,
        "vectors.json no longer matches the contract; if the change is deliberate, rewrite it with BAIL_WRITE_VECTORS=1"
    );
}
