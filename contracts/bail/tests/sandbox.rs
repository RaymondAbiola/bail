//! The compiled contract in a local NEAR sandbox, against a standard NEP-141 token.
//! Transfers, callbacks and access keys here are real, not mocked.
//!
//! Run with `cargo test -p bail --test sandbox`. The first run downloads the sandbox
//! node and compiles both contracts.

use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{CurveType, PublicKey};
use near_workspaces::network::Sandbox;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::OnceCell;

const DEPOSIT: u128 = 1_000_000;
const MINUTE: u64 = 60_000;
const WINDOW: u64 = MINUTE;
const CODES: [&str; 2] = ["alpha one", "bravo two"];
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

static WASM: OnceCell<(Vec<u8>, Vec<u8>)> = OnceCell::const_new();

/// Both contracts, compiled once per test run.
async fn wasm() -> anyhow::Result<&'static (Vec<u8>, Vec<u8>)> {
    WASM.get_or_try_init(|| async {
        let bail = near_workspaces::compile_project("./").await?;
        let token = near_workspaces::compile_project("../test-token").await?;
        anyhow::Ok((bail, token))
    })
    .await
}

struct World {
    worker: Worker<Sandbox>,
    bail: Contract,
    token: Contract,
    root: Account,
}

impl World {
    /// `fee` is the fee in basis points and the name of the fee account under root.
    async fn new(fee: Option<(u16, &str)>) -> anyhow::Result<Self> {
        let (bail_wasm, token_wasm) = wasm().await?;
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;
        let fee_bps = fee.map_or(0, |f| f.0);
        let fee_account: Option<AccountId> = fee
            .map(|f| format!("{}.{}", f.1, root.id()).parse())
            .transpose()?;
        let token = worker.dev_deploy(token_wasm).await?;
        token
            .call("new")
            .args_json(json!({ "owner_id": token.id(), "total_supply": U128(1_000 * DEPOSIT) }))
            .transact()
            .await?
            .into_result()?;
        let bail = worker.dev_deploy(bail_wasm).await?;
        bail.call("new")
            .args_json(json!({ "config": {
                "fee_bps": fee_bps,
                "fee_account": fee_account,
                "min_window_ms": MINUTE,
                "min_reveal_ms": MINUTE,
                "min_dispute_ms": MINUTE,
                "max_event_ms": 30 * 24 * 60 * MINUTE,
                "intents_account": null,
            }}))
            .transact()
            .await?
            .into_result()?;
        let world = Self {
            worker,
            bail,
            token,
            root,
        };
        world.register(world.bail.id()).await?;
        Ok(world)
    }

    async fn account(&self, name: &str) -> anyhow::Result<Account> {
        Ok(self
            .root
            .create_subaccount(name)
            .initial_balance(NearToken::from_near(20))
            .transact()
            .await?
            .into_result()?)
    }

    /// Registers an account with the token, so it can hold a balance.
    async fn register(&self, account: &AccountId) -> anyhow::Result<()> {
        self.root
            .call(self.token.id(), "storage_deposit")
            .args_json(json!({ "account_id": account }))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn fund(&self, account: &AccountId, amount: u128) -> anyhow::Result<()> {
        self.register(account).await?;
        self.token
            .as_account()
            .call(self.token.id(), "ft_transfer")
            .args_json(json!({ "receiver_id": account, "amount": U128(amount) }))
            .deposit(ONE_YOCTO)
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn balance(&self, account: &AccountId) -> anyhow::Result<u128> {
        let b: U128 = self
            .worker
            .view(self.token.id(), "ft_balance_of")
            .args_json(json!({ "account_id": account }))
            .await?
            .json()?;
        Ok(b.0)
    }

    async fn view(&self, method: &str, args: Value) -> anyhow::Result<Value> {
        Ok(self
            .worker
            .view(self.bail.id(), method)
            .args_json(args)
            .await?
            .json()?)
    }

    async fn now_ms(&self) -> anyhow::Result<u64> {
        Ok(self.worker.view_block().await?.timestamp() / 1_000_000)
    }

    /// Moves the chain clock past `target_ms`, whatever the sandbox's block time is.
    async fn advance_to(&self, target_ms: u64) -> anyhow::Result<()> {
        while self.now_ms().await? < target_ms {
            self.worker.fast_forward(20).await?;
        }
        Ok(())
    }

    /// Calls the contract from `who` and returns the result as JSON.
    async fn call(&self, who: &Account, method: &str, args: Value) -> anyhow::Result<Value> {
        let outcome = who
            .call(self.bail.id(), method)
            .args_json(args)
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        Ok(outcome.json().unwrap_or(Value::Null))
    }
}

struct Ticket {
    key: SigningKey,
}

impl Ticket {
    fn new(seed: u8) -> Self {
        Self {
            key: SigningKey::from_bytes(&[seed; 32]),
        }
    }

    fn bytes(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }

    fn public_key(&self) -> String {
        PublicKey::from_parts(CurveType::ED25519, self.bytes().to_vec())
            .unwrap()
            .to_string()
    }

    fn sign(&self, message: &str) -> Base64VecU8 {
        Base64VecU8(self.key.sign(message.as_bytes()).to_bytes().to_vec())
    }
}

/// The hash layout from ARCHITECTURE.md section 6.10, written again here with a
/// separate SHA-256 library, so the compiled contract has to agree with it.
fn slot_hash(
    domain: &[u8],
    contract: &AccountId,
    event: u64,
    slot: u8,
    code: &str,
    key: Option<&[u8; 32]>,
) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut field = |bytes: &[u8]| {
        buf.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        buf.extend_from_slice(bytes);
    };
    field(domain);
    field(contract.as_bytes());
    field(&event.to_le_bytes());
    field(&[slot]);
    field(code.as_bytes());
    if let Some(key) = key {
        field(key);
    }
    Sha256::digest(&buf).to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// An event with two one-minute code slots, both needed, opening ten minutes from now.
/// Check-in lasts four minutes: chain time moves in whole blocks, so a host needs slack
/// beyond `slots * window` to open each slot after the previous one closes.
async fn create_event(
    w: &World,
    organizer: &Account,
    arbiter: &Account,
    capacity: u32,
) -> anyhow::Result<(u64, Value)> {
    let now = w.now_ms().await?;
    let opens = now + 10 * MINUTE;
    let cost: NearToken = w
        .view("storage_cost", json!({ "capacity": capacity }))
        .await
        .map(|v| serde_json::from_value(v).unwrap())?;
    let id: u64 = organizer
        .call(w.bail.id(), "create_event")
        .args_json(json!({ "event": {
            "token": w.token.id(),
            "deposit": U128(DEPOSIT),
            "capacity": capacity,
            "arbiter": arbiter.id(),
            "cancel_cutoff_ms": now + 5 * MINUTE,
            "rsvp_closes_at_ms": opens,
            "checkin_opens_at_ms": opens,
            "checkin_closes_at_ms": opens + 4 * WINDOW,
            "reveal_ms": MINUTE,
            "dispute_ms": MINUTE,
            "checkin": { "slots": 2, "required": 2, "window_ms": WINDOW },
        }}))
        .deposit(cost)
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let event = w.view("get_event", json!({ "event_id": id })).await?;
    Ok((id, event))
}

async fn rsvp(
    w: &World,
    who: &Account,
    event: u64,
    ticket: &Ticket,
    payout_to: &str,
) -> anyhow::Result<()> {
    let msg =
        json!({ "event_id": event, "ticket_key": ticket.public_key(), "payout_to": payout_to });
    who.call(w.token.id(), "ft_transfer_call")
        .args_json(
            json!({ "receiver_id": w.bail.id(), "amount": U128(DEPOSIT), "msg": msg.to_string() }),
        )
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

#[tokio::test]
async fn a_whole_event_runs_on_the_compiled_contract() -> anyhow::Result<()> {
    let w = World::new(Some((500, "fees"))).await?;
    let fees = w.account("fees").await?;
    let fees_id = fees.id().clone();
    w.register(&fees_id).await?;
    let organizer = w.account("organizer").await?;
    let arbiter = w.account("arbiter").await?;
    let stranger = w.account("stranger").await?;

    // Alice, Bob, Carol and Frank catch both codes, Dave never shows, and Erin's phone
    // died. Frank's payout goes to a wallet the token has never seen, so his first
    // payout fails for real.
    let names = ["alice", "bob", "carol", "dave", "erin", "frank"];
    let mut people = Vec::new();
    for name in names {
        let account = w.account(name).await?;
        w.fund(account.id(), DEPOSIT).await?;
        people.push(account);
    }
    let tickets: Vec<Ticket> = (1..=6).map(Ticket::new).collect();
    let frank_wallet: AccountId = format!("frank-wallet.{}", w.root.id()).parse()?;

    let (id, event) = create_event(&w, &organizer, &arbiter, 10).await?;
    for (i, person) in people.iter().enumerate() {
        let payout = if i == 5 {
            format!("near:{frank_wallet}")
        } else {
            format!("near:{}", person.id())
        };
        rsvp(&w, person, id, &tickets[i], &payout).await?;
    }
    assert_eq!(
        w.view("get_event", json!({ "event_id": id })).await?["registered"],
        6
    );
    assert_eq!(w.balance(w.bail.id()).await?, 6 * DEPOSIT);

    // The host console signs with a function-call key that can only call open_slot.
    let host_key = SecretKey::from_seed(KeyType::ED25519, "host console");
    organizer
        .batch(organizer.id())
        .add_key(
            host_key.public_key(),
            AccessKey::function_call_access(
                w.bail.id(),
                &["open_slot"],
                Some(NearToken::from_near(1)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let host = Account::from_secret_key(organizer.id().clone(), host_key, &w.worker);

    let opens = event["schedule"]["checkin_opens_at_ms"].as_u64().unwrap();
    for (slot, code) in CODES.iter().enumerate() {
        let slot = slot as u8;
        // Each slot opens one window after the previous one actually opened, as read
        // from the chain: block times are never exact.
        let ready = match slot {
            0 => opens,
            _ => {
                let e = w.view("get_event", json!({ "event_id": id })).await?;
                e["slots"][usize::from(slot) - 1]["opened_at_ms"]
                    .as_u64()
                    .unwrap()
                    + WINDOW
            }
        };
        w.advance_to(ready).await?;
        let commitment = Base64VecU8(slot_hash(
            b"bail/v1/code",
            w.bail.id(),
            id,
            slot,
            code,
            None,
        ));
        // A function-call key's allowance is checked against the worst-case gas cost up
        // front, so the host key attaches realistic gas instead of the maximum.
        host.call(w.bail.id(), "open_slot")
            .args_json(json!({ "event_id": id, "slot": slot, "commitment": commitment }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?
            .into_result()?;
        for i in [0, 1, 2, 5] {
            let proof = slot_hash(
                b"bail/v1/proof",
                w.bail.id(),
                id,
                slot,
                code,
                Some(&tickets[i].bytes()),
            );
            let message = format!(
                "bail/v1/catch/{}/{id}/{slot}/1/{}",
                w.bail.id(),
                hex(&proof)
            );
            w.call(&stranger, "catch", json!({
                "event_id": id, "slot": slot, "attempt": 1, "ticket_key": tickets[i].public_key(),
                "proof": Base64VecU8(proof), "signature": tickets[i].sign(&message),
            }))
            .await?;
        }
    }

    // Any attendee can reveal the codes once their windows close; every window ends
    // before check-in closes.
    let closes = event["schedule"]["checkin_closes_at_ms"].as_u64().unwrap();
    w.advance_to(closes).await?;
    for (slot, code) in CODES.iter().enumerate() {
        w.call(
            &people[0],
            "reveal",
            json!({ "event_id": id, "slot": slot, "code": code }),
        )
        .await?;
    }

    // Alice and Bob vouch for Erin once attendance is final.
    let schedule = &event["schedule"];
    w.advance_to(schedule["reveal_deadline_ms"].as_u64().unwrap())
        .await?;
    for voucher in [0, 1] {
        let message = format!(
            "bail/v1/vouch/{}/{id}/{}",
            w.bail.id(),
            tickets[4].public_key()
        );
        w.call(
            &stranger,
            "vouch",
            json!({
                "event_id": id, "voucher_key": tickets[voucher].public_key(),
                "target_key": tickets[4].public_key(), "signature": tickets[voucher].sign(&message),
            }),
        )
        .await?;
    }

    // A stranger settles everything once the dispute window ends.
    w.advance_to(schedule["dispute_ends_at_ms"].as_u64().unwrap())
        .await?;
    while w
        .call(&stranger, "tally", json!({ "event_id": id, "limit": 2 }))
        .await?
        != json!("Done")
    {}
    let totals = w.view("event_totals", json!({ "event_id": id })).await?;
    assert_eq!(
        (
            totals["attended"].as_u64(),
            totals["vouched"].as_u64(),
            totals["forfeited"].as_u64()
        ),
        (Some(4), Some(1), Some(1))
    );
    // One forfeit pays a 5% fee and splits the rest four ways: 237,500 each.
    assert_eq!(totals["bonus"], json!("237500"));
    assert_eq!(totals["fee"], json!("50000"));

    while w
        .call(&stranger, "payout", json!({ "event_id": id, "limit": 2 }))
        .await?
        != json!(true)
    {}
    let attendee_share = DEPOSIT + 237_500;
    for i in [0, 1, 2] {
        assert_eq!(
            w.balance(people[i].id()).await?,
            attendee_share,
            "{}",
            names[i]
        );
    }
    assert_eq!(w.balance(people[3].id()).await?, 0, "dave forfeits");
    assert_eq!(
        w.balance(people[4].id()).await?,
        DEPOSIT,
        "erin's deposit comes back"
    );

    // Frank's transfer failed on the token, and the callback rolled it back.
    let franks = w
        .view(
            "get_ticket",
            json!({ "event_id": id, "ticket_key": tickets[5].public_key() }),
        )
        .await?;
    assert_eq!(franks["paid"], json!(false));
    w.register(&frank_wallet).await?;
    w.call(
        &stranger,
        "claim",
        json!({ "event_id": id, "ticket_key": tickets[5].public_key() }),
    )
    .await?;
    assert_eq!(w.balance(&frank_wallet).await?, attendee_share);

    w.call(
        &stranger,
        "claim_owed",
        json!({ "event_id": id, "payout_to": format!("near:{fees_id}") }),
    )
    .await?;
    assert_eq!(w.balance(&fees_id).await?, 50_000);

    // Every token the event took in went back out.
    assert_eq!(w.balance(w.bail.id()).await?, 0);

    let before = organizer.view_account().await?.balance;
    while w
        .call(
            &stranger,
            "close_event",
            json!({ "event_id": id, "limit": 4 }),
        )
        .await?
        != json!(true)
    {}
    let after = organizer.view_account().await?.balance;
    assert!(after > before, "the organizer gets unused storage back");
    assert_eq!(
        w.view("get_event", json!({ "event_id": id })).await?["closed"],
        json!(true)
    );
    Ok(())
}

#[tokio::test]
async fn the_host_key_can_only_open_slots() -> anyhow::Result<()> {
    let w = World::new(None).await?;
    let organizer = w.account("organizer").await?;
    let arbiter = w.account("arbiter").await?;
    let (id, _) = create_event(&w, &organizer, &arbiter, 5).await?;

    let host_key = SecretKey::from_seed(KeyType::ED25519, "host console");
    organizer
        .batch(organizer.id())
        .add_key(
            host_key.public_key(),
            AccessKey::function_call_access(
                w.bail.id(),
                &["open_slot"],
                Some(NearToken::from_near(1)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let host = Account::from_secret_key(organizer.id().clone(), host_key, &w.worker);

    // NEAR itself refuses: the key isn't allowed to call cancel_event, attach tokens, or
    // send NEAR, whatever the contract would say.
    let cancel = host
        .call(w.bail.id(), "cancel_event")
        .args_json(json!({ "event_id": id }))
        .deposit(ONE_YOCTO)
        .transact()
        .await;
    assert!(cancel.map_or(true, |r| r.is_failure()));
    let tally = host
        .call(w.bail.id(), "tally")
        .args_json(json!({ "event_id": id, "limit": 1 }))
        .transact()
        .await;
    assert!(tally.map_or(true, |r| r.is_failure()));
    let send = host
        .transfer_near(arbiter.id(), NearToken::from_near(1))
        .await;
    assert!(send.map_or(true, |r| r.is_failure()));
    assert_eq!(
        w.view("get_event", json!({ "event_id": id })).await?["status"],
        json!("Active")
    );
    Ok(())
}

#[tokio::test]
async fn only_the_contract_can_answer_a_transfer() -> anyhow::Result<()> {
    let w = World::new(None).await?;
    let attacker = w.account("attacker").await?;
    let outcome = attacker
        .call(w.bail.id(), "on_transfer")
        .args_json(json!({
            "event_id": 0, "ticket_key": null, "payout_to": format!("near:{}", attacker.id()),
            "amount": U128(DEPOSIT), "is_call": false,
        }))
        .max_gas()
        .transact()
        .await?;
    let failure = format!("{:?}", outcome.into_result().unwrap_err());
    assert!(
        failure.contains("Method on_transfer is private"),
        "{failure}"
    );
    Ok(())
}

#[tokio::test]
async fn only_the_contract_can_initialise_itself() -> anyhow::Result<()> {
    let (bail_wasm, _) = wasm().await?;
    let worker = near_workspaces::sandbox().await?;
    let bail = worker.dev_deploy(bail_wasm).await?;
    let attacker = worker.dev_create_account().await?;
    let outcome = attacker
        .call(bail.id(), "new")
        .args_json(json!({ "config": {
            "fee_bps": 1_000, "fee_account": attacker.id(),
            "min_window_ms": MINUTE, "min_reveal_ms": MINUTE, "min_dispute_ms": MINUTE,
            "max_event_ms": MINUTE, "intents_account": null,
        }}))
        .max_gas()
        .transact()
        .await?;
    let failure = format!("{:?}", outcome.into_result().unwrap_err());
    assert!(failure.contains("Method new is private"), "{failure}");
    Ok(())
}

/// The arbiter can be a community's Sputnik DAO, with no extra code in Bail: the council
/// votes on a FunctionCall proposal, and only when the vote passes does the DAO call
/// `void_event` with 1 yoctoNEAR. Uses the code testnet's DAO factory deploys today.
#[tokio::test]
async fn a_sputnik_dao_votes_to_void_an_event() -> anyhow::Result<()> {
    let w = World::new(None).await?;
    let organizer = w.account("organizer").await?;
    let stranger = w.account("stranger").await?;
    let council = [w.account("council-a").await?, w.account("council-b").await?];

    let dao = w
        .root
        .create_subaccount("dao")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let dao = dao
        .deploy(include_bytes!("sputnik/sputnikdao2.wasm"))
        .await?
        .into_result()?;
    dao.call("new")
        .args_json(json!({
            "config": { "name": "arbiter", "purpose": "Votes to void Bail events", "metadata": "" },
            "policy": [council[0].id(), council[1].id()],
        }))
        .transact()
        .await?
        .into_result()?;

    let (id, _) = create_event(&w, &organizer, dao.as_account(), 4).await?;
    let names = ["alice", "bob"];
    let mut people = Vec::new();
    for (i, name) in names.iter().enumerate() {
        let account = w.account(name).await?;
        w.fund(account.id(), DEPOSIT).await?;
        rsvp(
            &w,
            &account,
            id,
            &Ticket::new(i as u8 + 1),
            &format!("near:{}", account.id()),
        )
        .await?;
        people.push(account);
    }

    // Being on the council isn't being the arbiter: a member can't void it alone.
    let alone = council[0]
        .call(w.bail.id(), "void_event")
        .args_json(json!({ "event_id": id }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    assert!(format!("{:?}", alone.into_result().unwrap_err()).contains("only the arbiter can void"));

    let kind = json!({ "FunctionCall": {
        "receiver_id": w.bail.id(),
        "actions": [{
            "method_name": "void_event",
            "args": Base64VecU8::from(json!({ "event_id": id }).to_string().into_bytes()),
            "deposit": "1",
            "gas": "30000000000000",
        }],
    }});
    let proposal: u64 = council[0]
        .call(dao.id(), "add_proposal")
        .args_json(json!({ "proposal": { "description": "Void the event", "kind": kind } }))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let vote = |member: &Account| {
        member
            .call(dao.id(), "act_proposal")
            .args_json(json!({ "id": proposal, "action": "VoteApprove", "proposal": kind }))
            .max_gas()
            .transact()
    };

    // One of two votes isn't a majority, so nothing happens yet.
    vote(&council[0]).await?.into_result()?;
    let event = w.view("get_event", json!({ "event_id": id })).await?;
    assert_eq!(event["status"], "Active");

    let passed = vote(&council[1]).await?;
    assert!(passed.is_success(), "{:?}", passed.failures());
    let state: Value = w
        .worker
        .view(dao.id(), "get_proposal")
        .args_json(json!({ "id": proposal }))
        .await?
        .json()?;
    assert_eq!(state["status"], "Approved");
    let event = w.view("get_event", json!({ "event_id": id })).await?;
    assert_eq!(event["status"], "Voided");

    // A voided event settles at once, and everyone gets their deposit back.
    while w
        .call(&stranger, "tally", json!({ "event_id": id, "limit": 10 }))
        .await?
        != json!("Done")
    {}
    while w
        .call(&stranger, "payout", json!({ "event_id": id, "limit": 10 }))
        .await?
        != json!(true)
    {}
    for (person, name) in people.iter().zip(names) {
        assert_eq!(w.balance(person.id()).await?, DEPOSIT, "{name}");
    }
    Ok(())
}
