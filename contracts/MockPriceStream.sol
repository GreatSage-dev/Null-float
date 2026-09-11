// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/ISomniaEventHandler.sol";

/// @title MockPriceStream - Oracle & Precompile 0x0100 Emulator for Somnia Data Streams
/// @notice Emits settlement events and triggers ISomniaEventHandler.onEvent() for continuous rollover testing.
contract MockPriceStream {
    address public owner;

    event WindowSettlementPublished(
        uint256 indexed closedWindowId,
        uint256 indexed nextWindowId,
        uint256 spotPrice,
        uint256 emaPrice,
        bool outcome
    );

    constructor() {
        owner = msg.sender;
    }

    /// @notice Simulates an intra-block oracle settlement trigger invoking the clearinghouse
    function emitSettlement(
        address targetClearinghouse,
        uint256 closedWindowId,
        uint256 nextWindowId,
        uint256 spotPrice,
        uint256 emaPrice,
        bool outcome
    ) external returns (bool) {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = keccak256("WindowSettlement(uint256,uint256,uint256,uint256,bool)");
        topics[1] = bytes32(closedWindowId);

        bytes memory data = abi.encode(nextWindowId, spotPrice, emaPrice, outcome);

        emit WindowSettlementPublished(closedWindowId, nextWindowId, spotPrice, emaPrice, outcome);

        // Invokes the reactive handler
        ISomniaEventHandler(targetClearinghouse).onEvent(address(this), topics, data);
        return true;
    }
}
