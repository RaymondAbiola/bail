# Sputnik DAO contract, for the sandbox test

`sputnikdao2.wasm` is the code that NEAR testnet's Sputnik DAO factory, `sputnikv2.testnet`, deploys for every new DAO today. It was copied byte for byte from a DAO the factory created, and it is used only by the sandbox test `a_sputnik_dao_votes_to_void_an_event`.

Its NEAR code hash is `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`, which is the base58 form of the SHA-256 in `SHA256SUMS`. To check it is the factory's current code:

```bash
sha256sum -c SHA256SUMS
curl -s https://rpc.testnet.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"sputnikv2.testnet","method_name":"get_default_code_hash","args_base64":"e30="}}'
```

The second command returns the hash as bytes of a JSON string; it decodes to `"AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH"`. Source: [near-daos/sputnik-dao-contract](https://github.com/near-daos/sputnik-dao-contract).
