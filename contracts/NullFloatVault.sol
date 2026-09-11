// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title NullFloatVault - Non-Custodial Parity Liquidity Vault
/// @notice ERC-4626-inspired public vault where participants pool USDso.
///         The clearinghouse uses this collateral solely to quote two-sided parity markets
///         (YES + NO = 1.00) with zero inventory risk, returning collected spread to depositors.
contract NullFloatVault {
    string public constant name = "NullFloat Continuous Net Settlement Vault";
    string public constant symbol = "nfUSDso";
    uint8 public constant decimals = 18;

    address public immutable clearinghouse;
    address public owner;

    uint256 public totalAssets;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;

    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);
    event CapitalDeployed(uint256 amount);
    event CapitalReturned(uint256 returnedAmount, uint256 spreadEarned);

    modifier onlyClearinghouse() {
        require(msg.sender == clearinghouse, "NullFloatVault: caller not clearinghouse");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "NullFloatVault: caller not owner");
        _;
    }

    constructor(address _clearinghouse) {
        require(_clearinghouse != address(0), "NullFloatVault: invalid clearinghouse");
        clearinghouse = _clearinghouse;
        owner = msg.sender;
    }

    /// @notice Deposit native STT/USDso collateral and receive vault shares
    function deposit() external payable returns (uint256 shares) {
        require(msg.value > 0, "NullFloatVault: deposit zero");

        if (totalSupply == 0 || totalAssets == 0) {
            shares = msg.value;
        } else {
            shares = (msg.value * totalSupply) / totalAssets;
        }
        require(shares > 0, "NullFloatVault: zero shares minted");

        totalAssets += msg.value;
        totalSupply += shares;
        balanceOf[msg.sender] += shares;

        emit Deposit(msg.sender, msg.sender, msg.value, shares);
    }

    /// @notice Redeem vault shares for underlying collateral
    function withdraw(uint256 shares, address payable receiver) external returns (uint256 assets) {
        require(shares > 0, "NullFloatVault: withdraw zero");
        require(balanceOf[msg.sender] >= shares, "NullFloatVault: insufficient balance");
        require(receiver != address(0), "NullFloatVault: invalid receiver");

        assets = (shares * totalAssets) / totalSupply;
        require(address(this).balance >= assets, "NullFloatVault: insufficient liquidity in vault");

        balanceOf[msg.sender] -= shares;
        totalSupply -= shares;
        totalAssets -= assets;

        (bool sent, ) = receiver.call{value: assets}("");
        require(sent, "NullFloatVault: transfer failed");

        emit Withdraw(msg.sender, receiver, msg.sender, assets, shares);
    }

    /// @notice Clearinghouse draws capital for atomic intra-block parity seeding
    function pullCapital(uint256 amount) external onlyClearinghouse returns (bool) {
        require(amount <= address(this).balance, "NullFloatVault: insufficient balance for pull");
        (bool sent, ) = clearinghouse.call{value: amount}("");
        require(sent, "NullFloatVault: capital transfer to clearinghouse failed");
        emit CapitalDeployed(amount);
        return true;
    }

    /// @notice Clearinghouse returns recycled capital plus harvested spread
    function returnCapital(uint256 principal, uint256 spread) external payable {
        require(msg.sender == clearinghouse || msg.sender == owner, "NullFloatVault: unauthorized");
        require(msg.value >= principal + spread, "NullFloatVault: insufficient return payment");
        totalAssets += spread; // Spread accrues directly to all share holders
        emit CapitalReturned(principal, spread);
    }

    receive() external payable {}
}
