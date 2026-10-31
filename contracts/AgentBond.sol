// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title AgentBond
/// @notice Slashable bonds for AI agents, keyed by their ERC-8004 agent ID.
///
/// An agent's owner (the holder of its ERC-8004 identity NFT) posts a bond.
/// Escrow contracts approved as slashers lock part of it as cover for a single
/// job and, if the agent fails, pay it to the harmed buyer. A slasher can only
/// take what it locked itself, and can only lock bond that is neither locked
/// nor on its way out.
///
/// Trust limits: a new slasher only becomes active after one full unbonding
/// period, so agents who don't trust it have time to leave first. Withdrawals
/// wait out the same period, so an agent can't pull its bond just before a
/// claim lands. A retired slasher can't lock anything new but still settles
/// the locks it holds, so retiring one never strands a bond.
///
/// An agent usually runs on a hot key (its ERC-8004 agent wallet) while the
/// owner's key stays cold. The owner can cap how much cover the hot key may
/// commit, per job and per day, so a leaked key can only lose so much.
/// Slashers call `lockForWallet` for commitments the agent wallet signed.
contract AgentBond is Ownable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct Bond {
        uint256 total; // everything held for the agent
        uint256 locked; // covering open jobs; slashable
        uint256 pending; // requested for withdrawal; not lockable
        uint64 unlockAt; // when `pending` can be withdrawn
    }

    IERC20 public immutable bondToken;
    IERC721 public immutable identityRegistry;
    uint64 public immutable unbondingPeriod;

    mapping(uint256 agentId => Bond) public bonds;
    mapping(uint256 agentId => mapping(address slasher => uint256)) public lockedBy;
    /// @notice When each slasher becomes (or became) active; 0 means none.
    mapping(address slasher => uint64) public slasherActiveAt;
    mapping(address slasher => bool) public slasherRetired;

    /// @notice Caps on cover the agent wallet commits without the owner.
    /// Applied only when `enabled`; a zero cap then means no cover at all.
    struct WalletLimits {
        uint120 maxCoverPerJob;
        uint120 maxCoverPerDay;
        bool enabled;
    }

    struct WalletUsage {
        uint64 day; // block.timestamp / 1 days when `used` was counted
        uint192 used;
    }

    mapping(uint256 agentId => WalletLimits) public walletLimits;
    mapping(uint256 agentId => WalletUsage) public walletUsage;

    event Deposited(uint256 indexed agentId, address indexed from, uint256 amount);
    event WithdrawalRequested(uint256 indexed agentId, uint256 amount, uint64 unlockAt);
    event WithdrawalCancelled(uint256 indexed agentId);
    event Withdrawn(uint256 indexed agentId, address indexed to, uint256 amount);
    event Locked(uint256 indexed agentId, address indexed slasher, uint256 amount);
    event Unlocked(uint256 indexed agentId, address indexed slasher, uint256 amount);
    event Slashed(uint256 indexed agentId, address indexed slasher, address indexed to, uint256 amount);
    event SlasherProposed(address indexed slasher, uint64 activeAt);
    event SlasherRetired(address indexed slasher);
    event WalletLimitsSet(uint256 indexed agentId, uint120 maxCoverPerJob, uint120 maxCoverPerDay, bool enabled);

    error NotAgentOwner();
    error NotSlasher();
    error ZeroAmount();
    error InsufficientFreeBond(uint256 free, uint256 wanted);
    error InsufficientLockedBond(uint256 locked, uint256 wanted);
    error NothingPending();
    error StillUnbonding(uint64 unlockAt);
    error WalletLimitExceeded(uint256 allowed, uint256 wanted);

    constructor(IERC20 bondToken_, IERC721 identityRegistry_, uint64 unbondingPeriod_, address owner_)
        Ownable(owner_)
    {
        bondToken = bondToken_;
        identityRegistry = identityRegistry_;
        unbondingPeriod = unbondingPeriod_;
    }

    modifier onlyAgentOwner(uint256 agentId) {
        if (identityRegistry.ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        _;
    }

    modifier onlySlasher() {
        if (!isSlasher(msg.sender)) revert NotSlasher();
        _;
    }

    // ---------------------------------------------------------------- views

    /// @notice Whether `account` may lock bond for new jobs.
    function isSlasher(address account) public view returns (bool) {
        uint64 activeAt = slasherActiveAt[account];
        return activeAt != 0 && block.timestamp >= activeAt && !slasherRetired[account];
    }

    /// @notice Bond that is neither locked nor pending withdrawal: what new
    /// jobs can still be covered with.
    function freeBond(uint256 agentId) public view returns (uint256) {
        Bond storage b = bonds[agentId];
        return b.total - b.locked - b.pending;
    }

    // --------------------------------------------------------------- agents

    /// @notice Add to an agent's bond. Anyone may top up any agent.
    function deposit(uint256 agentId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        identityRegistry.ownerOf(agentId); // reverts for an unregistered agent
        bonds[agentId].total += amount;
        bondToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(agentId, msg.sender, amount);
    }

    /// @notice Start unbonding `amount` of free bond. A later request adds to
    /// the pending amount and restarts the clock.
    function requestWithdrawal(uint256 agentId, uint256 amount) external onlyAgentOwner(agentId) {
        if (amount == 0) revert ZeroAmount();
        uint256 free = freeBond(agentId);
        if (amount > free) revert InsufficientFreeBond(free, amount);
        Bond storage b = bonds[agentId];
        b.pending += amount;
        b.unlockAt = uint64(block.timestamp) + unbondingPeriod;
        emit WithdrawalRequested(agentId, b.pending, b.unlockAt);
    }

    /// @notice Cap the cover the agent wallet can commit. Takes effect for the
    /// next lock; cover already locked is unaffected.
    function setWalletLimits(uint256 agentId, uint120 maxCoverPerJob, uint120 maxCoverPerDay, bool enabled)
        external
        onlyAgentOwner(agentId)
    {
        walletLimits[agentId] = WalletLimits(maxCoverPerJob, maxCoverPerDay, enabled);
        emit WalletLimitsSet(agentId, maxCoverPerJob, maxCoverPerDay, enabled);
    }

    function cancelWithdrawal(uint256 agentId) external onlyAgentOwner(agentId) {
        Bond storage b = bonds[agentId];
        if (b.pending == 0) revert NothingPending();
        b.pending = 0;
        b.unlockAt = 0;
        emit WithdrawalCancelled(agentId);
    }

    /// @notice Pay out the pending amount to the agent's current owner.
    function withdraw(uint256 agentId) external nonReentrant onlyAgentOwner(agentId) {
        Bond storage b = bonds[agentId];
        uint256 amount = b.pending;
        if (amount == 0) revert NothingPending();
        if (block.timestamp < b.unlockAt) revert StillUnbonding(b.unlockAt);
        b.pending = 0;
        b.unlockAt = 0;
        b.total -= amount;
        bondToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(agentId, msg.sender, amount);
    }

    // ------------------------------------------------------------- slashers

    /// @notice Lock cover the agent's owner committed to.
    function lock(uint256 agentId, uint256 amount) external onlySlasher {
        _lock(agentId, amount);
    }

    /// @notice Lock cover the agent wallet committed to, within the owner's caps.
    function lockForWallet(uint256 agentId, uint256 amount) external onlySlasher {
        if (amount == 0) return;
        WalletLimits memory limits = walletLimits[agentId];
        if (limits.enabled) {
            if (amount > limits.maxCoverPerJob) revert WalletLimitExceeded(limits.maxCoverPerJob, amount);
            WalletUsage storage usage = walletUsage[agentId];
            uint64 today = uint64(block.timestamp / 1 days);
            uint256 used = usage.day == today ? usage.used : 0;
            if (used + amount > limits.maxCoverPerDay) {
                revert WalletLimitExceeded(limits.maxCoverPerDay > used ? limits.maxCoverPerDay - used : 0, amount);
            }
            usage.day = today;
            usage.used = uint192(used + amount);
        }
        _lock(agentId, amount);
    }

    function _lock(uint256 agentId, uint256 amount) private {
        if (amount == 0) return;
        uint256 free = freeBond(agentId);
        if (amount > free) revert InsufficientFreeBond(free, amount);
        bonds[agentId].locked += amount;
        lockedBy[agentId][msg.sender] += amount;
        emit Locked(agentId, msg.sender, amount);
    }

    function unlock(uint256 agentId, uint256 amount) external {
        if (amount == 0) return;
        _release(agentId, amount);
        emit Unlocked(agentId, msg.sender, amount);
    }

    /// @notice Take locked bond and pay it to `to`. Slashers should pass their
    /// own address and pay the harmed party themselves: a regulated stablecoin
    /// reverts transfers to a frozen address, and that must not block the slash.
    function slash(uint256 agentId, uint256 amount, address to) external nonReentrant {
        if (amount == 0) return;
        _release(agentId, amount);
        bonds[agentId].total -= amount;
        bondToken.safeTransfer(to, amount);
        emit Slashed(agentId, msg.sender, to, amount);
    }

    /// @dev Drop `amount` of the caller's own lock on an agent.
    function _release(uint256 agentId, uint256 amount) private {
        uint256 held = lockedBy[agentId][msg.sender];
        if (amount > held) revert InsufficientLockedBond(held, amount);
        lockedBy[agentId][msg.sender] = held - amount;
        bonds[agentId].locked -= amount;
    }

    // ---------------------------------------------------------------- owner

    /// @notice Approve a slasher. It becomes active after one unbonding period.
    function proposeSlasher(address slasher) external onlyOwner {
        uint64 activeAt = uint64(block.timestamp) + unbondingPeriod;
        slasherActiveAt[slasher] = activeAt;
        emit SlasherProposed(slasher, activeAt);
    }

    /// @notice Stop a slasher from locking bond for new jobs, at once and for
    /// good. It still settles the locks it already holds.
    function retireSlasher(address slasher) external onlyOwner {
        slasherRetired[slasher] = true;
        emit SlasherRetired(slasher);
    }
}
