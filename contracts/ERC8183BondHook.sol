// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AgentBond} from "./AgentBond.sol";
import {IAgentWallets} from "./AgentEscrow.sol";

/// @notice ERC-8183's hook interface (erc-8183/base-contracts): the core calls
/// these around each hookable action, with `data` ABI-encoded per selector.
interface IERC8183Hook is IERC165 {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}

/// @notice The job record of an ERC-8183 core, as the reference implementation
/// (erc-8183/base-contracts) returns it from `getJob`.
interface IERC8183Jobs {
    struct Job {
        address client;
        uint8 status;
        address provider;
        uint48 expiredAt;
        address evaluator;
        uint48 submittedAt;
        uint256 budget;
        address hook;
        address paymentToken;
        uint256 providerAgentId;
        string description;
        uint256 settledAmount;
        address payoutReceiver;
    }

    function getJob(uint256 jobId) external view returns (Job memory);
}

/// @title ERC8183BondHook
/// @notice Adds provider performance bonds to ERC-8183 jobs.
///
/// ERC-8183 escrows the client's budget until an evaluator completes or
/// rejects the job; the provider risks nothing. With this hook attached:
///
/// - When the provider sets the budget, it can offer cover in `optParams`:
///   `abi.encode(uint256 agentId, uint256 cover, uint256 deliverBy)`. The
///   provider must act for that ERC-8004 agent (owner or agent wallet), and
///   `deliverBy` must come before the job expires, while the core still
///   accepts a submission.
/// - When the client funds, the cover is locked in AgentBond. If the agent's
///   free bond can't cover it, funding reverts: a client never funds a job
///   whose cover isn't really there.
/// - A submission after `deliverBy` is refused. If nothing was submitted by
///   then, anyone can call `slashLate` and the cover goes to the client.
///   (ERC-8183's own `claimRefund` runs no hooks by design, so the client
///   reclaims its budget there separately.)
/// - Completion releases the cover. A rejection on quality also releases it:
///   the bond answers for lateness, which anyone can check, not for taste.
/// - If the provider delivered on time but the job is never settled, anyone
///   can release the cover once `staleAfter` has passed since `deliverBy`.
/// - Lateness is judged from the core's record of the submission too. The
///   core's admin can detach a hook from a job (`batchDetachHook` in the
///   reference implementation); the hook then misses the submission, but an
///   on-time provider still can't be slashed.
///
/// Only the configured ERC-8183 core may call the hook. Selectors are set at
/// deployment, so the hook can be pointed at any core that follows the
/// standard's encodings and returns the reference implementation's job record
/// from `getJob`. Payouts that a frozen address can't receive are credited, as
/// in AgentEscrow. Claim-based (streaming) flows aren't bonded.
contract ERC8183BondHook is IERC8183Hook, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    struct Selectors {
        bytes4 setBudget;
        bytes4 fund;
        bytes4 submit;
        bytes4 complete;
        bytes4 reject;
    }

    enum State {
        None,
        Offered,
        Locked,
        Settled
    }

    struct Bonded {
        address client;
        uint40 deliverBy;
        uint40 submittedAt;
        State state;
        bool byWallet;
        uint112 cover;
        uint256 agentId;
    }

    address public immutable core;
    AgentBond public immutable bond;
    IERC20 public immutable bondToken;
    IERC721 public immutable identityRegistry;
    uint64 public immutable staleAfter;
    bytes4 public immutable setBudgetSelector;
    bytes4 public immutable fundSelector;
    bytes4 public immutable submitSelector;
    bytes4 public immutable completeSelector;
    bytes4 public immutable rejectSelector;

    mapping(uint256 jobId => Bonded) public jobs;
    mapping(address account => uint256) public owed;

    event CoverOffered(uint256 indexed jobId, uint256 indexed agentId, uint256 cover, uint256 deliverBy);
    event CoverLocked(uint256 indexed jobId, uint256 indexed agentId, address indexed client, uint256 cover);
    event CoverReleased(uint256 indexed jobId, uint256 indexed agentId);
    event CoverSlashed(uint256 indexed jobId, uint256 indexed agentId, address indexed client, uint256 cover);
    event PaymentDeferred(address indexed account, uint256 amount);
    event OwedWithdrawn(address indexed account, uint256 amount);

    error NotCore();
    error NotAgent();
    error BadTerms(string reason);
    error WrongState(State state);
    error NotLate();
    error NotStale();
    error NothingOwed();

    constructor(address core_, AgentBond bond_, uint64 staleAfter_, Selectors memory selectors) {
        core = core_;
        bond = bond_;
        bondToken = bond_.bondToken();
        identityRegistry = bond_.identityRegistry();
        staleAfter = staleAfter_;
        setBudgetSelector = selectors.setBudget;
        fundSelector = selectors.fund;
        submitSelector = selectors.submit;
        completeSelector = selectors.complete;
        rejectSelector = selectors.reject;
    }

    modifier onlyCore() {
        if (msg.sender != core) revert NotCore();
        _;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC8183Hook).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ----------------------------------------------------------------- hook

    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata) external view onlyCore {
        // A late submission is refused, as AgentEscrow refuses it.
        if (selector == submitSelector) {
            Bonded storage job = jobs[jobId];
            if (job.state == State.Locked && block.timestamp > job.deliverBy) revert BadTerms("late");
        }
    }

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyCore {
        if (selector == setBudgetSelector) _onSetBudget(jobId, data);
        else if (selector == fundSelector) _onFund(jobId, data);
        else if (selector == submitSelector) _onSubmit(jobId);
        else if (selector == completeSelector) _release(jobId);
        else if (selector == rejectSelector) _onReject(jobId);
    }

    // --------------------------------------------------------------- anyone

    /// @notice Pay the cover to the client when nothing was submitted by
    /// `deliverBy`.
    function slashLate(uint256 jobId) external nonReentrant {
        Bonded storage job = jobs[jobId];
        if (job.state != State.Locked) revert WrongState(job.state);
        if (block.timestamp <= job.deliverBy || _onTime(jobId, job)) revert NotLate();
        _slash(jobId, job);
    }

    /// @notice Release the cover of a job delivered on time but never settled.
    function releaseStale(uint256 jobId) external {
        Bonded storage job = jobs[jobId];
        if (job.state != State.Locked) revert WrongState(job.state);
        if (!_onTime(jobId, job) || block.timestamp <= uint256(job.deliverBy) + staleAfter) revert NotStale();
        _release(jobId);
    }

    /// @notice Collect a payout that couldn't be transferred when it was due.
    /// Pays only the account it is owed to.
    function withdrawOwed() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        bondToken.safeTransfer(msg.sender, amount);
        emit OwedWithdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------- internal

    function _onSetBudget(uint256 jobId, bytes calldata data) private {
        Bonded storage job = jobs[jobId];
        if (job.state == State.Locked || job.state == State.Settled) revert WrongState(job.state);
        (address caller,,, bytes memory optParams) = abi.decode(data, (address, address, uint256, bytes));
        if (optParams.length == 0) {
            delete jobs[jobId]; // no cover offered (or a previous offer withdrawn)
            return;
        }
        (uint256 agentId, uint256 cover, uint256 deliverBy) = abi.decode(optParams, (uint256, uint256, uint256));
        // The core refuses a submission from `expiredAt` on (0: no expiry), so
        // a later deadline could be missed with no way to deliver.
        uint256 expiredAt = IERC8183Jobs(core).getJob(jobId).expiredAt;
        if (deliverBy <= block.timestamp || (expiredAt != 0 && deliverBy >= expiredAt)) revert BadTerms("deliverBy");
        bool byOwner = caller == identityRegistry.ownerOf(agentId);
        if (!byOwner && (caller == address(0) || caller != _agentWallet(agentId))) revert NotAgent();
        jobs[jobId] = Bonded({
            client: address(0),
            deliverBy: deliverBy.toUint40(),
            submittedAt: 0,
            state: State.Offered,
            byWallet: !byOwner,
            cover: cover.toUint112(),
            agentId: agentId
        });
        emit CoverOffered(jobId, agentId, cover, deliverBy);
    }

    function _onFund(uint256 jobId, bytes calldata data) private {
        Bonded storage job = jobs[jobId];
        if (job.state != State.Offered) return; // an unbonded job
        if (block.timestamp >= job.deliverBy) revert BadTerms("deliverBy");
        (address client,) = abi.decode(data, (address, bytes));
        // Hiring yourself only manufactures reputation.
        if (client == identityRegistry.ownerOf(job.agentId) || client == _agentWallet(job.agentId)) {
            revert BadTerms("self-dealing");
        }
        job.client = client;
        job.state = State.Locked;
        if (job.byWallet) bond.lockForWallet(job.agentId, job.cover);
        else bond.lock(job.agentId, job.cover);
        emit CoverLocked(jobId, job.agentId, client, job.cover);
    }

    function _onSubmit(uint256 jobId) private {
        Bonded storage job = jobs[jobId];
        if (job.state == State.Locked) job.submittedAt = uint40(block.timestamp);
    }

    function _onReject(uint256 jobId) private {
        Bonded storage job = jobs[jobId];
        if (job.state == State.Offered) {
            delete jobs[jobId]; // cancelled before funding
        } else if (job.state == State.Locked) {
            if (job.submittedAt == 0 && block.timestamp > job.deliverBy) _slash(jobId, job);
            else _release(jobId);
        }
    }

    function _release(uint256 jobId) private {
        Bonded storage job = jobs[jobId];
        if (job.state != State.Locked) return;
        job.state = State.Settled;
        bond.unlock(job.agentId, job.cover);
        emit CoverReleased(jobId, job.agentId);
    }

    /// @dev Whether the work was submitted by `deliverBy`, by the hook's record
    /// or, if the hook was detached and missed it, by the core's.
    function _onTime(uint256 jobId, Bonded storage job) private view returns (bool) {
        if (job.submittedAt != 0) return true; // the hook refuses late submissions
        uint256 submittedAt = IERC8183Jobs(core).getJob(jobId).submittedAt;
        return submittedAt != 0 && submittedAt <= job.deliverBy;
    }

    function _slash(uint256 jobId, Bonded storage job) private {
        job.state = State.Settled;
        bond.slash(job.agentId, job.cover, address(this));
        _pay(job.client, job.cover);
        emit CoverSlashed(jobId, job.agentId, job.client, job.cover);
    }

    /// @dev Transfer, or credit `to` if the transfer fails (a frozen address).
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        if (!bondToken.trySafeTransfer(to, amount)) {
            owed[to] += amount;
            emit PaymentDeferred(to, amount);
        }
    }

    function _agentWallet(uint256 agentId) private view returns (address) {
        try IAgentWallets(address(identityRegistry)).getAgentWallet(agentId) returns (address wallet) {
            return wallet;
        } catch {
            return address(0);
        }
    }
}
