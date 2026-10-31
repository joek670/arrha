// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IERC8183Hook} from "../ERC8183BondHook.sol";

/// @notice A minimal ERC-8183 job escrow for tests. Not the reference
/// implementation: it follows the published lifecycle (Open, Funded,
/// Submitted, then Completed, Rejected or Expired), roles, and hook calls with
/// the documented `data` encodings, and leaves out fees, claims and
/// relayed authorisations. `claimRefund` runs no hooks, as in the standard.
contract MockERC8183 {
    enum Status {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        address client;
        address provider;
        address evaluator;
        uint256 expiry;
        address hook;
        uint256 agentId;
        address token;
        uint256 budget;
        Status status;
    }

    uint256 public jobCount;
    mapping(uint256 => Job) public jobs;

    function createJob(address provider, address evaluator, uint256 expiry, string calldata, address hook, uint256 agentId)
        external
        returns (uint256 jobId)
    {
        if (hook != address(0)) {
            require(ERC165Checker.supportsInterface(hook, type(IERC8183Hook).interfaceId), "InvalidHook");
        }
        jobId = ++jobCount;
        jobs[jobId] = Job(msg.sender, provider, evaluator, expiry, hook, agentId, address(0), 0, Status.Open);
    }

    function setBudget(uint256 jobId, address token, uint256 amount, bytes calldata optParams) external {
        Job storage job = jobs[jobId];
        require(msg.sender == job.provider && job.status == Status.Open, "setBudget");
        bytes memory data = abi.encode(msg.sender, token, amount, optParams);
        _before(job, jobId, this.setBudget.selector, data);
        job.token = token;
        job.budget = amount;
        _after(job, jobId, this.setBudget.selector, data);
    }

    function fund(uint256 jobId, address expectedToken, uint256 expectedBudget, bytes calldata optParams) external {
        Job storage job = jobs[jobId];
        require(msg.sender == job.client && job.status == Status.Open, "fund");
        require(job.token == expectedToken && job.budget == expectedBudget, "budget changed");
        bytes memory data = abi.encode(msg.sender, optParams);
        _before(job, jobId, this.fund.selector, data);
        IERC20(job.token).transferFrom(msg.sender, address(this), job.budget);
        job.status = Status.Funded;
        _after(job, jobId, this.fund.selector, data);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external {
        Job storage job = jobs[jobId];
        require(msg.sender == job.provider && job.status == Status.Funded, "submit");
        bytes memory data = abi.encode(msg.sender, deliverable, optParams);
        _before(job, jobId, this.submit.selector, data);
        job.status = Status.Submitted;
        _after(job, jobId, this.submit.selector, data);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external {
        Job storage job = jobs[jobId];
        require(msg.sender == job.evaluator && job.status == Status.Submitted, "complete");
        bytes memory data = abi.encode(msg.sender, reason, optParams);
        _before(job, jobId, this.complete.selector, data);
        job.status = Status.Completed;
        IERC20(job.token).transfer(job.provider, job.budget);
        _after(job, jobId, this.complete.selector, data);
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external {
        Job storage job = jobs[jobId];
        bool open = job.status == Status.Open && (msg.sender == job.client || msg.sender == job.provider);
        bool funded = (job.status == Status.Funded || job.status == Status.Submitted) && msg.sender == job.evaluator;
        require(open || funded, "reject");
        bytes memory data = abi.encode(msg.sender, reason, optParams);
        _before(job, jobId, this.reject.selector, data);
        job.status = Status.Rejected;
        if (funded) IERC20(job.token).transfer(job.client, job.budget);
        _after(job, jobId, this.reject.selector, data);
    }

    /// @notice Permissionless after expiry; never hookable.
    function claimRefund(uint256 jobId) external {
        Job storage job = jobs[jobId];
        require(block.timestamp > job.expiry, "not expired");
        require(job.status == Status.Funded || job.status == Status.Submitted, "claimRefund");
        job.status = Status.Expired;
        IERC20(job.token).transfer(job.client, job.budget);
    }

    function _before(Job storage job, uint256 jobId, bytes4 selector, bytes memory data) private {
        if (job.hook != address(0)) IERC8183Hook(job.hook).beforeAction(jobId, selector, data);
    }

    function _after(Job storage job, uint256 jobId, bytes4 selector, bytes memory data) private {
        if (job.hook != address(0)) IERC8183Hook(job.hook).afterAction(jobId, selector, data);
    }
}
