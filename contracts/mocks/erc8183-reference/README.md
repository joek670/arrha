# ERC-8183 reference implementation (vendored, for tests only)

These files are copied unmodified from
[erc-8183/base-contracts](https://github.com/erc-8183/base-contracts) at commit
`142e669` (2026-06-30), under the MIT license in `LICENSE`. Arrha does not
deploy them. `test/erc8183.test.mjs` runs `ERC8183BondHook` against them.

| File | SHA-256 |
|---|---|
| `ERC8183.sol` | `c5db4bcdc89dce6cc53629a19fcbcb73e973bc07f83b07a730aa4712bdedb1e4` |
| `ERC8183WithAuthorization.sol` | `75042e29e58dcb91766acc6641deb1b664df5e612b0e89100391a5cb3da0e9a8` |
| `IERC8183Hook.sol` | `2d7797c0b59e793092cf67db93ac9d715500372b144de3d12dbadca70b63d744` |
| `IDisburser.sol` | `51e8dae2f2f0e34fa31a777edb67b45bd5d50a8bc341c605e4eaa5f4f3724209` |
| `LICENSE` | `40953fdb2ef029617b15a370dcbee145499b771b591b23caeffbc784a6d0af1c` |

The upstream `foundry.lock` pins OpenZeppelin v5.6.1. Arrha pins the same
version of `@openzeppelin/contracts` and `@openzeppelin/contracts-upgradeable`.

To update, fetch each file at the new commit, for example:

```
gh api "repos/erc-8183/base-contracts/contents/contracts/ERC8183.sol?ref=<commit>" --jq .content
```

Then base64-decode it, replace the file, and update this table.
