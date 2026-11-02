# Optimistic disputes: design rules

Status: not built. This page records the rules that the design must follow,
before any code is written. The roadmap item is: the buyer's claim stands
unless the provider posts a counter-bond, with AI-drafted rulings that people
can appeal.

Today a disputed job goes to a trusted arbiter. The arbiter splits the payment
and can slash up to the cover. If the arbiter does nothing for 3 days, the
buyer is refunded and the cover is unlocked. Late jobs need no arbiter.

## Rules

- **Bond only what is cheap to check, or pay for the check.** A NeurIPS 2026
  paper argues that, for escrow with a challenge path, the ratio of
  verification cost to job price sets the security level, and the strength of
  the verification method does not. Above a threshold, no bond that a seller
  would accept makes a challenge worth it. Lateness costs nothing to check,
  because the contract reads the clock. This is why Arrha slashes late jobs
  with no judge. Quality costs more to check, so a quality dispute must carry
  its own checking cost: the counter-bond and the cover must be larger than
  the cost of a ruling, or nobody disputes.
- **Size bonds by how often a bad delivery is caught.** The same paper puts it
  this way: a bond of 10% of the price is a bet that a cheat is caught more
  than 9 times in 10. Set the counter-bond and the cover from the expected
  catch rate, not as a fixed share of the price.
- **Never cap a challenger's reward below the cheater's exposure.** The paper
  argues that such a cap makes silence pay more than reporting: a private side
  payment beats the mechanism. Today the buyer is the only challenger and
  receives the full cover. If a later design pays third parties to challenge
  (for example, watchers that check proofs of work), each challenger's reward
  must be at least what the cheating party stands to lose.
- **AI first, people on appeal.** The dispute starts with a cheap AI ruling,
  and either side can appeal to human jurors by posting a bond. This is the
  pattern of UMA's optimistic oracle (a bonded claim stands unless someone
  disputes it within a window) and of the Agentic Commerce court that Kleros
  is building (AI jurors first, human jurors on appeal; in development as of
  September 2026).
- **Put the dispute terms in the quote.** The Recourse paper binds each agent
  action to its scope, recovery, evidence, payout and collateral before the
  action runs. Arrha's quote already binds the price, the cover, the deadline
  and a hash of the job spec. A quote that allows quality disputes must also
  name what evidence a dispute needs and who rules on it.

## Sources

Only the abstracts of the two papers were read. Check the full texts before
the design is fixed.

- [Why Verification-Gated Settlement Does Not Close: Structural Failure Modes
  in Agent-to-Agent Contracts](https://neurips.cc/virtual/2026/172897)
  (NeurIPS 2026)
- [Bonded Recourse for Smart-Contract Settlement of Compensable Agent Side
  Effects](https://arxiv.org/pdf/2609.01939) (arXiv 2609.01939)
- [Kleros development update, September
  2026](https://blog.kleros.io/kleros-development-update-september-2026/)
- [How prediction markets resolve: UMA's optimistic oracle
  explained](https://crypto.news/how-prediction-markets-resolve-uma-optimistic-oracle/)
