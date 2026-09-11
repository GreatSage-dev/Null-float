// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ISomniaEventHandler - Native Somnia Onchain Reactivity Interface
/// @notice Implemented by contracts subscribing to native Somnia Data Streams via precompile 0x0100.
interface ISomniaEventHandler {
    function onEvent(address emitter, bytes32[] calldata topics, bytes calldata data) external;
}
