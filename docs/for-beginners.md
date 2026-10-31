# Arrha, explained for beginners

No crypto or programming knowledge needed. Words in **bold** are explained in
the glossary at the end. The name comes from *arrha*, the Roman-law word for
earnest money: a deposit you forfeit if you don't do what you promised.

## The problem

AI programs, called **agents**, are starting to hire each other. Your research
agent might pay a translation agent $5 to translate a report, or a data agent
$2 to clean a spreadsheet. They pay each other in **stablecoins**: digital
dollars that move over the internet in seconds, for a fraction of a cent.

That speed comes with a catch: **a crypto payment is final.** It works like
handing over cash. Pay by card and you can dispute a charge for months. An
agent that pays in crypto has no such option. If the translation agent takes
the $5 and never delivers, the money is gone.

## What Arrha does

Think of hiring a contractor who has posted a bond. Before taking jobs, the
contractor sets money aside with a third party. If they walk off the job, the
bond pays you. Arrha does the same for AI agents, automatically:

1. **The seller agent puts money aside**, its **bond**, in a public
   **smart contract**: a program on the blockchain that nobody can quietly
   change, including us.
2. **For each job it makes a signed promise:** "I'll deliver by Friday. If I
   don't, you get your money back *plus* $10 from my bond."
3. **Your payment waits in a lockbox** (**escrow**) until the job is done.
4. **If the seller is late, anyone can press the button**, and you are refunded
   and paid the $10. No customer service, no court, no waiting for a decision.
   The contract checks the clock itself.
5. **If the work arrives but is bad**, a referee (the **arbiter**) splits the
   money. The referee can never take more from the seller than the seller
   promised up front.

The seller loses money every time it fails. That is the point: good sellers
don't mind, and bad sellers can't afford to keep failing.

## Why choose this over what already exists?

| Option | What happens if the seller doesn't deliver |
|---|---|
| **Plain crypto payments** (for example x402, the standard way agents pay each other) | Nothing. The payment is final, and you lose it. |
| **Escrow services** (Coinbase's Commerce Payments, the ERC-8183 job standard) | You get your own money back, eventually. The seller loses nothing, so a bad seller can simply try again with the next customer. |
| **Reviews and star ratings** | Easy to fake. A 2026 study of the main agent-review registry found that 59–91% of reviewers were fake accounts working together. A seller with a great reputation can also cheat once, cash out, and come back under a new name. |
| **Arrha** | You get your money back **plus** the amount the seller put at risk, automatically. The seller pays for every failure. |

Arrha also plugs into the ERC-8183 job standard as an add-on, so a job there
can carry a seller's bond too.

Three more things set it apart:

- **An honest track record.** Each agent gets a risk score built only from real,
  paid jobs, never from reviews. Faking a record costs real money in fees, and
  jobs from the same buyer count for less and less, so a seller can't
  pad its record by buying from itself. Every score comes with plain reasons,
  for example "1 delivered, 1 late out of 2 jobs; on-time delivery estimated
  at 55%", so you can see why.
- **Built for regulated digital dollars.** Stablecoin companies can freeze an
  account by law. A simple escrow can get stuck when that happens. Arrha
  keeps working and holds the frozen party's money for them.
- **Nothing to buy.** There is no coin to purchase to use it. It works with the
  digital dollars people already use, on Base, a widely used network.

## When it's the right choice, and when it isn't

**Use it** for jobs worth about a dollar or more that take minutes to days,
where a no-show costs you something.

**Skip it** for tiny pay-per-click requests worth fractions of a cent. Arrha
costs a few cents per job in network fees, which would cost more than the
request itself; plain payments are better there. Skip it too when you already
fully trust the seller.

## What it costs

- **Trying it:** free, on a test network that uses play money.
- **Each real job:** roughly 1 to 16 cents in network fees, depending on how
  busy the network is.
- **Setting it up once:** under a few dollars.

## What it is not, yet

- **Not live.** It has not run on a real network yet; the next step is a test
  network.
- **Not audited.** Independent security experts need to review it before it
  holds anyone's real money.
- **Not a coin.** There is no token, and the service doesn't depend on one.
- **Not a judge of quality.** The contract knows whether work arrived on time,
  not whether it is good. For quality, there is still a referee.

## Glossary

- **Agent:** an AI program that acts on its own: it searches, writes, buys
  services and pays for them.
- **Stablecoin, USDC:** a digital dollar. One USDC is meant to be worth one US
  dollar, backed by cash and short-term US government debt.
- **Blockchain:** a shared public record of who owns what, kept by many
  computers at once, so nobody can secretly change it.
- **Smart contract:** a program stored on a blockchain. It does exactly what its
  code says, in public, and nobody can quietly change it.
- **Escrow:** money held by a neutral party until a deal is done.
- **Bond, cover:** money a seller puts at risk. The *cover* is the part of the
  bond promised to one particular job.
- **Slash:** to take part of a bond as a penalty, here paid to the buyer who was
  let down.
- **Arbiter:** the referee for disputes about quality.
- **Base:** a fast, low-cost network built by Coinbase on top of Ethereum.
- **ERC-8004:** a public standard that gives each AI agent an ID card on the
  blockchain.
- **x402:** a standard way for agents to pay for things over the web.
- **Network fee (gas):** the small fee every blockchain transaction pays to the
  network.

*Research and prototype only; not financial advice.*
