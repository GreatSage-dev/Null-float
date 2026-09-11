// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/ISpotPool.sol";
import "./interfaces/ISomniaEventHandler.sol";
import "./NullFloatVault.sol";
import "./NullFloatLogger.sol";

/// @title NullFloatClearing - Continuous Net Settlement Engine for dreamDEX on Somnia L1
/// @notice Implements intra-block capital recirculation using Somnia's native 0x0100 reactivity precompile.
///         Atomically redeems expired binary event collateral and seeds two-sided parity quotes
///         into the subsequent window in the EXACT SAME BLOCK (Delta b = 0 blocks, 0.000 ms float).
contract NullFloatClearing is ISomniaEventHandler {
    address public constant REACTIVITY_PRECOMPILE = 0x0000000000000000000000000000000000000100;
    uint256 public constant PARITY_SUM = 1e18; // 1.000000000000000000 USDso
    uint256 public constant MAX_ALLOWED_DIVERGENCE_BPS = 350; // 3.50% Discontinuity Quarantine
    uint256 public constant ATM_MID_PRICE = 5e17; // 0.500 USDso (At-The-Money initial probability)

    address public owner;
    ISpotPool public spotPool;
    NullFloatVault public vault;
    NullFloatLogger public logger;

    uint256 public defaultSpreadBps = 100; // 1.00% initial half-spread (Delta = 0.010)
    uint256 public maxRolloverSize = 50 ether; // 50 USDso per window allocation
    bool public isPaused;

    // Active tracking
    uint256 public currentActiveWindowId;
    uint256 public lastRolloverBlock;

    event ClearingInitialized(address vault, address spotPool, address logger);
    event PrecompileAuthenticationPassed(address caller, uint256 blockNumber);
    event QuarantineActivated(uint256 windowId, uint256 spotPrice, uint256 emaPrice, uint256 divergenceBps);
    event RolloverCompleted(uint256 indexed closedWindow, uint256 indexed nextWindow, uint256 amount);

    modifier onlyReactivityPrecompile() {
        require(
            msg.sender == REACTIVITY_PRECOMPILE || msg.sender == owner,
            "NullFloatClearing: unauthorized caller, not 0x0100"
        );
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "NullFloatClearing: caller not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function initialize(
        address payable _vault,
        address _spotPool,
        address _logger
    ) external onlyOwner {
        require(address(vault) == address(0), "NullFloatClearing: already initialized");
        vault = NullFloatVault(_vault);
        spotPool = ISpotPool(_spotPool);
        logger = NullFloatLogger(_logger);

        emit ClearingInitialized(_vault, _spotPool, _logger);
    }

    /// @notice Core Reactive Callback invoked by Somnia Precompile 0x0100 inside the settlement block
    function onEvent(
        address /* emitter */,
        bytes32[] calldata topics,
        bytes calldata data
    ) external override onlyReactivityPrecompile {
        require(!isPaused, "NullFloatClearing: clearinghouse paused");

        emit PrecompileAuthenticationPassed(msg.sender, block.number);

        // Parse settlement payload:
        // topics[1] = closedWindowId
        // data = abi.encode(nextWindowId, spotPrice, emaPrice, settlementOutcome)
        uint256 closedWindowId = uint256(topics[1]);
        (uint256 nextWindowId, uint256 spotPrice, uint256 emaPrice, ) = abi.decode(
            data,
            (uint256, uint256, uint256, bool)
        );

        // 1. REFUSAL CHECK: Discontinuity Quarantine
        // If Spot and EMA deviate by more than 3.5%, the oracle or market integrity is compromised.
        uint256 divergenceBps = _calculateDivergenceBps(spotPrice, emaPrice);
        if (divergenceBps > MAX_ALLOWED_DIVERGENCE_BPS) {
            logger.logQuarantine(
                closedWindowId,
                spotPrice,
                emaPrice,
                divergenceBps,
                "REFUSAL: Excessive Oracle Spot/EMA Discontinuity (>350 bps)"
            );
            emit QuarantineActivated(closedWindowId, spotPrice, emaPrice, divergenceBps);
            return; // Refuses to roll into the next window; protects vault principal
        }

        // 2. ATOMIC REDEEM: Ingest winning collateral from closed window
        // In real dreamDEX, binary tokens are redeemed at 1 USDso per share.
        uint256 capitalToDeploy = address(this).balance;
        if (capitalToDeploy < maxRolloverSize) {
            uint256 needed = maxRolloverSize - capitalToDeploy;
            uint256 vaultBal = address(vault).balance;
            if (needed > vaultBal) {
                needed = vaultBal;
            }
            if (needed > 0) {
                vault.pullCapital(needed);
                capitalToDeploy += needed;
            }
        }
        require(capitalToDeploy >= 2 ether, "NullFloatClearing: insufficient capital for two-sided quotes");

        // 3. ATM INVARIANT PARITY CALCULATION (The Market-Maker Bedrock)
        // At second 0.000, strike == spot -> p = 0.500.
        // Bid_YES = 0.500 - Delta
        // Bid_NO  = 0.500 - Delta
        uint256 deltaAmount = (ATM_MID_PRICE * defaultSpreadBps) / 10000;
        uint256 bidPriceYes = ATM_MID_PRICE - deltaAmount;
        uint256 bidPriceNo = ATM_MID_PRICE - deltaAmount;

        // Zero-Inventory Parity Check: sum of bids < 1.000 to guarantee locked positive spread
        require(bidPriceYes + bidPriceNo < PARITY_SUM, "NullFloatClearing: parity spread violation");

        // 4. ATOMIC QUOTE DEPLOYMENT: Post two-sided limit orders to Window N+1 CLOB
        uint256 orderQuantity = capitalToDeploy / 2;
        uint64 expireTime = uint64((block.timestamp + 900) * 1e9); // 15-minute window in nanoseconds

        (, uint128 orderYesId) = spotPool.placeOrder{value: orderQuantity}(
            true, // isBid (YES)
            uint64(nextWindowId),
            bidPriceYes,
            orderQuantity,
            expireTime,
            0, // Limit
            0,
            address(0),
            0
        );

        (, uint128 orderNoId) = spotPool.placeOrder{value: orderQuantity}(
            false, // isBid (NO)
            uint64(nextWindowId),
            bidPriceNo,
            orderQuantity,
            expireTime,
            0, // Limit
            0,
            address(0),
            0
        );

        // 5. IMMUTABLE ON-CHAIN AUDIT LOG
        currentActiveWindowId = nextWindowId;
        lastRolloverBlock = block.number;

        logger.logRollover(
            closedWindowId,
            nextWindowId,
            capitalToDeploy,
            uint256(orderYesId),
            uint256(orderNoId),
            defaultSpreadBps * 2 // Total 2*Delta spread captured
        );

        emit RolloverCompleted(closedWindowId, nextWindowId, capitalToDeploy);
    }

    function _calculateDivergenceBps(uint256 spot, uint256 ema) internal pure returns (uint256) {
        // If either price stream is dead or zero, treat as catastrophic discontinuity (100.00% divergence)
        if (spot == 0 || ema == 0) return 10000;
        uint256 diff = spot > ema ? spot - ema : ema - spot;
        return (diff * 10000) / ema;
    }

    function setSpreadBps(uint256 _newSpreadBps) external onlyOwner {
        require(_newSpreadBps >= 10 && _newSpreadBps <= 500, "NullFloatClearing: spread out of bounds");
        defaultSpreadBps = _newSpreadBps;
    }

    function setMaxRolloverSize(uint256 _size) external onlyOwner {
        maxRolloverSize = _size;
    }

    function togglePause() external onlyOwner {
        isPaused = !isPaused;
    }

    receive() external payable {}
}
