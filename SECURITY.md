# Security

## Status

Arrha is **unaudited** and has **not been deployed to any mainnet** by its
authors. Use it on test networks only. Don't put real money into a deployment
until an independent audit is complete.

## Reporting a vulnerability

Please report vulnerabilities **privately**, through GitHub: open the
repository's **Security** tab and choose **Report a vulnerability**. Don't open a
public issue, pull request or discussion about a vulnerability.

A useful report says:

- what is affected (contract, function, SDK call or script);
- how to reproduce it, ideally as a failing test in `test/`;
- what an attacker gains, or what breaks.

You'll get an acknowledgement as soon as we can, and a fix or a plan before
anything about the issue is made public. There is no bug bounty yet; one is
planned before any mainnet deployment.

## Scope

In scope: `contracts/` (not `contracts/mocks/`), `sdk/`, and
`scripts/deploy.mjs`.

Known limits are listed under **Limits** in the README: the trusted arbiter,
the owner's powers, the dependency on the ERC-8004 registry, agent-wallet keys
and the rest. Reports that show one of these is worse than described are
welcome.
