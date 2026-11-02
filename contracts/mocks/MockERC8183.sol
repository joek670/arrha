// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IERC8183Hook} from "../ERC8183BondHook.sol";

/// @notice A minimal ERC-8183 job escrow for tests. Not the reference
/// implementation (that one is vendored in `erc8183-reference/`): it follows
/// the published lifecycle (Open, Funded, Submitted, then Completed, Rejected
/// or Expired), roles, hook calls with the documented `data` encodings, and the
/// reference's `getJob` record, and leaves out fees, claims, whitelists, pauses
/// and relayed authorisations. `claimRefund` runs no hooks, as in the standard.
contract MockERC8183 {
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    /// @notice The same fields, in the same order, as the reference's job record.
    struct Job {
        address client;
        JobStatus status;
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

    uint256 public jobCounter;
    mapping(uint256 => Job) private jobs;

    function createJob(
        address provider,
        address evaluator,
        uint48 expiredAt,
        string calldata description,
        address hook,
        uint256 providerAgentId
    ) external returns (uint256 jobId) {
        if (hook != address(0)) {
            require(ERC165Checker.supportsInterface(hook, type(IERC8183Hook).interfaceId), "InvalidHook");
        }
        jobId = ++jobCounter;
        Job storage job = jobs[jobId];
        job.client = msg.sender;
        job.provider = provider;
        job.expiredAt = expiredAt;
        job.evaluator = evaluator;
        job.hook = hook;
        job.providerAgentId = providerAgentId;
        job.description = description;
    }

    function setBudget(uint256 jobId, address token, uint256 amount, bytes calldata optParams) external {
        Job storage job = jobs[jobId];
        require(msg.sender == job.provider && job.status == JobStatus.Open, "setBudget");
        bytes memory data = abi.encode(msg.sender, token, amount, optParams);
        _before(job, jobId, this.setBudget.selector, data);
        job.paymentToken = token;
        job.budget = amount;
        _after(job, jobId, this.setBudget.selector, data);
    }

    function fund(uint256 jobId, address expectedToken, uint256 expectedBudget, bytes calldata optParams) external {
        Job storage job = jobs[jobId];
        require(msg.sender == job.client && job.status == JobStatus.Open, "fund");
        require(job.paymentToken == expectedToken && job.budget == expectedBudget, "budget changed");
        bytes memory data = abi.encode(msg.sender, optParams);
        _before(job, jobId, this.fund.selector, data);
        IERC20(job.paymentToken).transferFrom(msg.sender, address(this), job.budget);
        job.status = JobStatus.Funded;
        _after(job, jobId, this.fund.selector, data);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external {
        Job storage job = jobs[jobId];
        require(msg.sender == job.provider && job.status == JobStatus.Funded, "submit");
        require(block.timestamp < job.expiredAt, "expired");
        bytes memory data = abi.encode(msg.sender, deliverable, optParams);
        _before(job, jobId, this.submit.selector, data);
        job.status = JobStatus.Submitted;
        job.submittedAt = uint48(block.timestamp);
        _after(job, jobId, this.submit.selector, data);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external {
        Job storage job = jobs[jobId];
        require(msg.sender == job.evaluator && job.status == JobStatus.Submitted, "complete");
        bytes memory data = abi.encode(msg.sender, reason, optParams);
        _before(job, jobId, this.complete.selector, data);
        job.status = JobStatus.Completed;
        IERC20(job.paymentToken).transfer(job.provider, job.budget);
        _after(job, jobId, this.complete.selector, data);
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external {
        Job storage job = jobs[jobId];
        bool open = job.status == JobStatus.Open && (msg.sender == job.client || msg.sender == job.provider);
        bool funded = (job.status == JobStatus.Funded || job.status == JobStatus.Submitted) && msg.sender == job.evaluator;
        require(open || funded, "reject");
        bytes memory data = abi.encode(msg.sender, reason, optParams);
        _before(job, jobId, this.reject.selector, data);
        job.status = JobStatus.Rejected;
        if (funded) IERC20(job.paymentToken).transfer(job.client, job.budget);
        _after(job, jobId, this.reject.selector, data);
    }

    /// @notice Permissionless from expiry; never hookable.
    function claimRefund(uint256 jobId) external {
        Job storage job = jobs[jobId];
        require(block.timestamp >= job.expiredAt, "not expired");
        require(job.status == JobStatus.Funded || job.status == JobStatus.Submitted, "claimRefund");
        job.status = JobStatus.Expired;
        IERC20(job.paymentToken).transfer(job.client, job.budget);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    function _before(Job storage job, uint256 jobId, bytes4 selector, bytes memory data) private {
        if (job.hook != address(0)) IERC8183Hook(job.hook).beforeAction(jobId, selector, data);
    }

    function _after(Job storage job, uint256 jobId, bytes4 selector, bytes memory data) private {
        if (job.hook != address(0)) IERC8183Hook(job.hook).afterAction(jobId, selector, data);
    }
}
