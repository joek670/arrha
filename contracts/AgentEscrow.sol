// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {AgentBond} from "./AgentBond.sol";
import {IAccountPolicy} from "./IAccountPolicy.sol";

/// @notice The ERC-8004 IdentityRegistry's verified payment wallet for an
/// agent (zero when none is set).
interface IAgentWallets {
    function getAgentWallet(uint256 agentId) external view returns (address);
}

/// @notice EIP-3009 as implemented by USDC: a payee-only transfer, authorised
/// by the payer's signature.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title AgentEscrow
/// @notice Bonded delivery for paid agent work.
///
/// A provider agent signs a quote (price, bond cover, deadline, terms). A buyer
/// opens a job with it: the payment goes into escrow and the provider's bond
/// cover is locked in AgentBond. Then one of:
///
/// - the provider submits a result and the buyer releases it, or the review
///   window passes: the provider is paid, less the protocol fee;
/// - the provider misses the deadline: the buyer is refunded and the bond
///   cover is slashed to the buyer, with no arbiter involved;
/// - the buyer disputes within the review window: the arbiter splits the
///   payment and decides how much cover to slash. If the arbiter doesn't act
///   in time, the buyer is refunded and the cover is unlocked.
///
/// A quote can name a policy contract the buyer must pass (a sanctions screen,
/// a KYC attestation), so providers that need compliance can have it without
/// making the escrow permissioned for everyone.
///
/// Payouts never block settlement. Regulated stablecoins can freeze an address,
/// and a transfer to it reverts; when one fails, the amount is credited to the
/// recipient instead, and only that recipient can withdraw it, once the token
/// lets it move again.
///
/// An agent works through its ERC-8004 agent wallet when it has one: that
/// wallet can sign quotes and submit results, and it is paid. The owner (the
/// NFT holder) can always do the same, and alone controls the bond in
/// AgentBond. So the owner's key can stay cold while the agent runs on a hot
/// one. A leaked agent-wallet key can still spend the agent's free bond, by
/// signing quotes for fake jobs and letting them run late, so keep the bond to
/// what that key is trusted with. Registries without agent wallets fall back
/// to the owner for everything.
///
/// Every settlement emits `JobSettled`, which an indexer can turn into
/// ERC-8004 reputation feedback.
contract AgentEscrow is Ownable, ReentrancyGuardTransient, EIP712 {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    enum Status {
        None,
        Open,
        Submitted,
        Disputed,
        Settled
    }

    enum Outcome {
        Released,
        Claimed,
        Late,
        Arbitrated,
        ArbiterTimedOut
    }

    struct Quote {
        uint256 agentId;
        address buyer; // address(0): any buyer
        uint256 amount;
        uint256 bondCover;
        uint64 deadline;
        uint64 expiry; // last moment the quote can be accepted
        bytes32 terms; // hash of the off-chain job spec
        address policy; // IAccountPolicy the buyer must pass; address(0): none
        bytes32 salt; // makes each quote unique
    }

    /// @dev Packed into three storage slots. The job's terms and result
    /// hashes live in the JobOpened and JobSubmitted events, where indexers
    /// and arbiters read them; no on-chain logic needs them stored.
    struct Job {
        address buyer;
        uint40 deadline;
        uint40 windowEndsAt; // review or arbitration window, by status
        Status status;
        uint128 amount;
        uint112 bondCover;
        uint16 feeBps;
        uint256 agentId;
    }

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(uint256 agentId,address buyer,uint256 amount,uint256 bondCover,uint64 deadline,uint64 expiry,bytes32 terms,address policy,bytes32 salt)"
    );
    uint16 public constant MAX_FEE_BPS = 100; // 1%

    IERC20 public immutable paymentToken;
    IERC20 public immutable bondToken;
    AgentBond public immutable bond;
    IERC721 public immutable identityRegistry;
    uint64 public immutable reviewPeriod;
    uint64 public immutable arbitrationPeriod;

    address public arbiter;
    address public treasury;
    uint16 public feeBps;
    /// @notice The largest job `open` accepts; 0 means no cap. A guarded
    /// launch keeps this low until the contracts have a track record.
    uint256 public maxJobAmount;

    uint256 public jobCount;
    mapping(uint256 jobId => Job) public jobs;
    mapping(bytes32 quoteDigest => bool) public quoteUsed;

    /// @notice Payouts that failed to transfer, by token and recipient.
    mapping(address token => mapping(address account => uint256)) public owed;

    /// @notice Running totals, so revenue can be checked on-chain rather than
    /// taken from a report: every job amount ever escrowed, and every fee.
    uint256 public totalVolume;
    uint256 public totalFees;

    event JobOpened(
        uint256 indexed jobId, uint256 indexed agentId, address indexed buyer, uint256 amount, uint256 bondCover, bytes32 terms
    );
    event JobSubmitted(uint256 indexed jobId, bytes32 result);
    event JobDisputed(uint256 indexed jobId);
    event JobSettled(
        uint256 indexed jobId,
        uint256 indexed agentId,
        Outcome outcome,
        uint256 toProvider,
        uint256 toBuyer,
        uint256 slashed,
        uint256 fee
    );
    event PaymentDeferred(address indexed token, address indexed account, uint256 amount);
    event OwedWithdrawn(address indexed token, address indexed account, uint256 amount);
    event ArbiterSet(address arbiter);
    event TreasurySet(address treasury);
    event FeeSet(uint16 feeBps);
    event MaxJobAmountSet(uint256 amount);

    error BadQuote(string reason);
    error BadSignature();
    error PolicyRejected(address policy);
    error WrongStatus(Status status);
    error NotBuyer();
    error NotProvider();
    error NotArbiter();
    error TooEarly();
    error TooLate();
    error FeeTooHigh();
    error BadSplit();
    error NothingOwed();
    error ZeroAddress();

    constructor(
        IERC20 paymentToken_,
        AgentBond bond_,
        uint64 reviewPeriod_,
        uint64 arbitrationPeriod_,
        address arbiter_,
        address treasury_,
        uint16 feeBps_,
        address owner_
    ) Ownable(owner_) EIP712("ArrhaEscrow", "1") {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (treasury_ == address(0)) revert ZeroAddress();
        paymentToken = paymentToken_;
        bond = bond_;
        bondToken = bond_.bondToken();
        identityRegistry = bond_.identityRegistry();
        reviewPeriod = reviewPeriod_;
        arbitrationPeriod = arbitrationPeriod_;
        arbiter = arbiter_;
        treasury = treasury_;
        feeBps = feeBps_;
    }

    // ---------------------------------------------------------------- views

    function quoteDigest(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    q.agentId,
                    q.buyer,
                    q.amount,
                    q.bondCover,
                    q.deadline,
                    q.expiry,
                    q.terms,
                    q.policy,
                    q.salt
                )
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice The agent's ERC-8004 agent wallet, or zero when it has none or
    /// the registry doesn't support agent wallets.
    function agentWallet(uint256 agentId) public view returns (address) {
        try IAgentWallets(address(identityRegistry)).getAgentWallet(agentId) returns (address wallet) {
            return wallet;
        } catch {
            return address(0);
        }
    }

    /// @notice Who is paid for an agent's work: its agent wallet, else its owner.
    function payeeOf(uint256 agentId) public view returns (address) {
        address wallet = agentWallet(agentId);
        return wallet != address(0) ? wallet : identityRegistry.ownerOf(agentId);
    }

    /// @notice Whether `account` may sign quotes and submit results for an agent.
    function actsFor(uint256 agentId, address account) public view returns (bool) {
        if (account == identityRegistry.ownerOf(agentId)) return true;
        return account != address(0) && account == agentWallet(agentId);
    }

    // ---------------------------------------------------------------- buyer

    /// @notice Accept a provider's signed quote: pay into escrow and lock the
    /// provider's bond cover. `signature` must come from the agent's owner or
    /// its agent wallet; ERC-1271 smart accounts are supported. The buyer
    /// approves the payment token to the escrow first.
    function open(Quote calldata q, bytes calldata signature) external nonReentrant returns (uint256 jobId) {
        (jobId,) = _open(q, signature, msg.sender);
        paymentToken.safeTransferFrom(msg.sender, address(this), q.amount);
    }

    /// @notice Open a job with the buyer's EIP-3009 authorisation instead of
    /// an approval, so the buyer signs once, sends no transaction and needs no
    /// ETH: anyone can relay it. The authorisation is `receiveWithAuthorization`
    /// to this escrow for the quote's amount, with the quote's digest as its
    /// nonce, so it can only ever pay for this exact quote, and only through
    /// this contract.
    function openWithAuthorization(
        Quote calldata q,
        bytes calldata signature,
        address buyer,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 jobId) {
        bytes32 digest;
        (jobId, digest) = _open(q, signature, buyer);
        IERC3009(address(paymentToken)).receiveWithAuthorization(
            buyer, address(this), q.amount, validAfter, validBefore, digest, v, r, s
        );
    }

    /// @notice Pay the provider now. Allowed before or after submission.
    function release(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (msg.sender != job.buyer) revert NotBuyer();
        if (job.status != Status.Open && job.status != Status.Submitted) revert WrongStatus(job.status);
        _payProvider(jobId, job, Outcome.Released);
    }

    function dispute(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (msg.sender != job.buyer) revert NotBuyer();
        if (job.status != Status.Submitted) revert WrongStatus(job.status);
        if (block.timestamp > job.windowEndsAt) revert TooLate();
        job.status = Status.Disputed;
        job.windowEndsAt = (block.timestamp + arbitrationPeriod).toUint40();
        emit JobDisputed(jobId);
    }

    // ------------------------------------------------------------- provider

    function submit(uint256 jobId, bytes32 result) external {
        Job storage job = jobs[jobId];
        if (!actsFor(job.agentId, msg.sender)) revert NotProvider();
        if (job.status != Status.Open) revert WrongStatus(job.status);
        if (block.timestamp > job.deadline) revert TooLate();
        job.status = Status.Submitted;
        job.windowEndsAt = (block.timestamp + reviewPeriod).toUint40();
        emit JobSubmitted(jobId, result);
    }

    // --------------------------------------------------------------- anyone

    /// @notice Pay the provider once the buyer's review window has passed.
    function claim(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.status != Status.Submitted) revert WrongStatus(job.status);
        if (block.timestamp <= job.windowEndsAt) revert TooEarly();
        _payProvider(jobId, job, Outcome.Claimed);
    }

    /// @notice Refund the buyer and slash the full cover when the provider
    /// missed the deadline without submitting.
    function refundLate(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.status != Status.Open) revert WrongStatus(job.status);
        if (block.timestamp <= job.deadline) revert TooEarly();
        job.status = Status.Settled;
        bond.slash(job.agentId, job.bondCover, address(this));
        _pay(bondToken, job.buyer, job.bondCover);
        _pay(paymentToken, job.buyer, job.amount);
        emit JobSettled(jobId, job.agentId, Outcome.Late, 0, job.amount, job.bondCover, 0);
    }

    /// @notice Refund the buyer and unlock the cover when the arbiter let a
    /// dispute run past the arbitration window.
    function expireDispute(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.status != Status.Disputed) revert WrongStatus(job.status);
        if (block.timestamp <= job.windowEndsAt) revert TooEarly();
        job.status = Status.Settled;
        bond.unlock(job.agentId, job.bondCover);
        _pay(paymentToken, job.buyer, job.amount);
        emit JobSettled(jobId, job.agentId, Outcome.ArbiterTimedOut, 0, job.amount, 0, 0);
    }

    /// @notice Collect a payout that couldn't be transferred when its job
    /// settled. Pays only the account it is owed to, so a freeze can't be
    /// sidestepped by redirecting the funds.
    function withdrawOwed(IERC20 token) external nonReentrant {
        uint256 amount = owed[address(token)][msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[address(token)][msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit OwedWithdrawn(address(token), msg.sender, amount);
    }

    // -------------------------------------------------------------- arbiter

    /// @notice Settle a dispute: `buyerBps` of the payment goes back to the
    /// buyer, the rest to the provider (less the fee), and `slashAmount` of
    /// the cover (capped at the cover) is paid to the buyer.
    function resolve(uint256 jobId, uint16 buyerBps, uint256 slashAmount) external nonReentrant {
        if (msg.sender != arbiter) revert NotArbiter();
        Job storage job = jobs[jobId];
        if (job.status != Status.Disputed) revert WrongStatus(job.status);
        if (buyerBps > 10_000) revert BadSplit();
        uint256 amount = job.amount;
        uint256 cover = job.bondCover;
        if (slashAmount > cover) slashAmount = cover;
        job.status = Status.Settled;

        uint256 toBuyer = amount * buyerBps / 10_000;
        uint256 providerGross = amount - toBuyer;
        uint256 fee = providerGross * job.feeBps / 10_000;
        uint256 toProvider = providerGross - fee;
        totalFees += fee;

        bond.slash(job.agentId, slashAmount, address(this));
        bond.unlock(job.agentId, cover - slashAmount);
        _pay(bondToken, job.buyer, slashAmount);
        _pay(paymentToken, job.buyer, toBuyer);
        if (toProvider > 0) _pay(paymentToken, payeeOf(job.agentId), toProvider);
        _pay(paymentToken, treasury, fee);
        emit JobSettled(jobId, job.agentId, Outcome.Arbitrated, toProvider, toBuyer, slashAmount, fee);
    }

    // ---------------------------------------------------------------- owner

    function setArbiter(address arbiter_) external onlyOwner {
        arbiter = arbiter_;
        emit ArbiterSet(arbiter_);
    }

    /// @notice Fees are paid here. Never the zero address: a fee that can't be
    /// transferred is credited to its recipient, and nobody can collect for 0x0.
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @notice Applies to jobs opened afterwards; open jobs keep their fee.
    function setFee(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
    }

    /// @notice Cap the size of new jobs (0 removes the cap). Open jobs are unaffected.
    function setMaxJobAmount(uint256 amount) external onlyOwner {
        maxJobAmount = amount;
        emit MaxJobAmountSet(amount);
    }

    // ------------------------------------------------------------- internal

    /// @dev Check a quote for `buyer`, record the job and lock the cover. The
    /// caller then collects the payment.
    function _open(Quote calldata q, bytes calldata signature, address buyer)
        private
        returns (uint256 jobId, bytes32 digest)
    {
        if (q.buyer != address(0) && q.buyer != buyer) revert BadQuote("buyer");
        if (block.timestamp > q.expiry) revert BadQuote("expired");
        if (q.deadline <= block.timestamp) revert BadQuote("deadline");
        if (q.amount == 0) revert BadQuote("amount");
        if (maxJobAmount != 0 && q.amount > maxJobAmount) revert BadQuote("too large");

        digest = quoteDigest(q);
        if (quoteUsed[digest]) revert BadQuote("used");
        address owner_ = identityRegistry.ownerOf(q.agentId);
        address wallet = agentWallet(q.agentId);
        // Hiring yourself only manufactures reputation.
        if (buyer == owner_ || (wallet != address(0) && buyer == wallet)) revert BadQuote("self-dealing");
        bool byOwner = SignatureChecker.isValidSignatureNow(owner_, digest, signature);
        if (!byOwner && (wallet == address(0) || !SignatureChecker.isValidSignatureNow(wallet, digest, signature))) {
            revert BadSignature();
        }
        if (q.policy != address(0) && !IAccountPolicy(q.policy).isAllowed(buyer)) revert PolicyRejected(q.policy);
        quoteUsed[digest] = true;

        jobId = ++jobCount;
        jobs[jobId] = Job({
            buyer: buyer,
            deadline: uint256(q.deadline).toUint40(),
            windowEndsAt: 0,
            status: Status.Open,
            amount: q.amount.toUint128(),
            bondCover: q.bondCover.toUint112(),
            feeBps: feeBps,
            agentId: q.agentId
        });
        totalVolume += q.amount;

        // Cover the agent wallet signed for stays within the owner's caps.
        if (byOwner) bond.lock(q.agentId, q.bondCover);
        else bond.lockForWallet(q.agentId, q.bondCover);
        emit JobOpened(jobId, q.agentId, buyer, q.amount, q.bondCover, q.terms);
    }

    function _payProvider(uint256 jobId, Job storage job, Outcome outcome) private {
        job.status = Status.Settled;
        uint256 amount = job.amount;
        uint256 fee = amount * job.feeBps / 10_000;
        uint256 toProvider = amount - fee;
        totalFees += fee;
        bond.unlock(job.agentId, job.bondCover);
        _pay(paymentToken, payeeOf(job.agentId), toProvider);
        _pay(paymentToken, treasury, fee);
        emit JobSettled(jobId, job.agentId, outcome, toProvider, 0, 0, fee);
    }

    /// @dev Transfer, or credit `to` if the transfer fails (a frozen address).
    function _pay(IERC20 token, address to, uint256 amount) private {
        if (amount == 0) return;
        if (!token.trySafeTransfer(to, amount)) {
            owed[address(token)][to] += amount;
            emit PaymentDeferred(address(token), to, amount);
        }
    }
}
