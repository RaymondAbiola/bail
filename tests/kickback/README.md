# Kickback comparison test

This Foundry project runs Kickback's own contract and shows its organizer taking every deposit. The same attack fails against Bail; see `the_kickback_attack_fails_against_bail` and the tests next to it in `contracts/bail/src/tests.rs`.

## Run it

```bash
cd tests/kickback
forge test -vv
```

Expect `[PASS] test_organizerTakesEveryDepositByMarkingOnlyTheirOwnAccount()`. The test passes because the attack succeeds: one sock-puppet account ends up holding all four deposits, and a real attendee's withdrawal reverts with "event still active or you did not attend". Foundry downloads Solidity 0.5.17 on the first run.

## What the attack does

1. Alice, Bob and Carol register with a 1 ETH deposit each, and the organizer registers one account they control.
2. Before the event happens, the organizer calls `finalize` with a bitmap that marks only their own account. Kickback's `finalize` (`AbstractConference.sol`, line 266) is `onlyAdmin onlyActive`: it checks nothing about time and needs nothing from attendees.
3. The organizer's account withdraws `totalBalance / totalAttended`, which is all 4 ETH. The real attendees can withdraw nothing.

## Where the code comes from

Every file under `src/` is copied unchanged, so the test runs against exactly what Kickback deployed. Only the files Kickback's ETH-deposit path needs are included.

| Source | Version | Licence |
|---|---|---|
| [wearekickback/contracts](https://github.com/wearekickback/contracts), `contracts/` | commit `4c992f85877e1ed38d21602640ddb9ef9e353c11` (22 August 2021) | MIT, `src/kickback/LICENSE.md` |
| [OpenZeppelin/openzeppelin-contracts](https://github.com/OpenZeppelin/openzeppelin-contracts), `contracts/` | tag `v2.5.1` (the version pinned in Kickback's `yarn.lock`), commit `837828967a9831e4333d5fb9edefb200a357d24d` | MIT, `src/openzeppelin-solidity/LICENSE` |

SHA-256 of each copied file, so anyone can check it against upstream:

```
25fbdcf58c980dda9e8b564eb5c371308d7f9784af0c3000c0cfcb0153da4638  kickback/AbstractConference.sol
f9d57b95b65ed226df656cf810704e410253a085a119835619956b408246488a  kickback/Conference.sol
91d3ffd98ff33decdb172aec072bcf781b2dee804053bef47b2d11c617c7099a  kickback/DeployerInterface.sol
bc1d760a5bae872b8cadc3683eb3e3cff71f1ef8f0147689bc6545d088f27c2b  kickback/Deployer.sol
feb055d8d1f8a7bb2f70b0e88bc3b605e5d84e6ce106f61dcb6da2ca7c62f46d  kickback/EthConference.sol
e798be8c8a2e8bb16e13cb2d84fa065438cfa7e4162f880076237f51ae7f9efc  kickback/EthDeployer.sol
5ef0190b682b285f574878cf6f06eb24e8825efdebb5d4b841620774dd6adfb2  kickback/GroupAdmin.sol
bb8758c0c5d6eeaad4a9417d586ed8e3847ae934d19d4b69c7eaae882bdf894f  kickback/Utils.sol
a0730bb86f57a40fc96e9a8c17ceac2600b8ce8734ad904fd4c29f020a9e49a3  kickback/zeppelin/lifecycle/Destructible.sol
3a908c422da822ab73277b549d49909451fa2be99cc7766729ef45f23e5a941d  kickback/zeppelin/ownership/Ownable.sol
2dcdf04c2e4e886f6d5193bbe93fbb33746439902fe572032d6040bcf01de634  kickback/zeppelin/security/Pausable.sol
3ac012ea56e72391d0a1117a35b24f903f2804cd0e47288e605f246ff5ca5279  openzeppelin-solidity/contracts/drafts/Counters.sol
3029cadb62d7b2f22a75ff2cbf2b8b7ab3de3cbcfea16ece2e6c86caae94caa3  openzeppelin-solidity/contracts/GSN/Context.sol
11f9dca3aaefa199950390a14a5b217b8f9194373e3a86c46e97c7039bafa759  openzeppelin-solidity/contracts/introspection/ERC165.sol
7e06653d36b04b9068d86acd5e29be9fa76434839afa0a3bb9f4862b0301c808  openzeppelin-solidity/contracts/introspection/IERC165.sol
ccbc65eddc0fe23db1360af754dfc534f2ab28ab1d2e79c1ca0cc9420a96dc58  openzeppelin-solidity/contracts/math/SafeMath.sol
f7d34b4a944c3f0a80da24ef6e3b864c46758890a895d6a37a435eb984c3b903  openzeppelin-solidity/contracts/token/ERC721/ERC721.sol
dac19cc65bd1a261fe4f498dd784acc492bf2c53d631f10a87ea2327dbb92d22  openzeppelin-solidity/contracts/token/ERC721/IERC721Receiver.sol
551702ed2bdc0516e9615e2d180d7b3861c86d91948a3cb11e477723d942d20c  openzeppelin-solidity/contracts/token/ERC721/IERC721.sol
5fdd34a9bf892f4d469c270b9cd43c34f3a75c19d9a374369fa95cc8b4863b2b  openzeppelin-solidity/contracts/utils/Address.sol
```

The same list is in `SHA256SUMS`. Check it with `cd tests/kickback/src && sha256sum -c ../SHA256SUMS`, or `cmp` each file against a checkout of the upstream commits.

The test itself, `test/KickbackAttack.t.sol`, is ours. It declares the four Foundry cheatcodes it uses, so it needs no libraries.
