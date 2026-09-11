// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ISpotPool - DreamDEX SpotPool Interface
/// @notice Surface of the DreamDEX SpotPool for order placement, querying, and cancellation.
interface ISpotPool {
    struct OrderInfo {
        uint128 orderId;
        bool isBid;
        address owner;
        uint64 userData;
        uint256 price;
        uint256 fullQuantity;
        uint256 quantityRemaining;
        uint64 expireTimestampNs;
    }

    function placeOrder(
        bool isBid,
        uint64 userData,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k
    ) external payable returns (bool success, uint128 orderId);

    function placeOrderFor(
        address owner,
        bool isBid,
        uint64 userData,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k
    ) external payable returns (bool success, uint128 orderId);

    function cancelOrder(uint128 orderId) external;

    function cancelOrderFor(address owner, uint128 orderId) external;

    function reduceOrder(uint128 orderId, uint256 newQuantityRemaining) external;

    function getOrder(uint128 orderId) external view returns (OrderInfo memory);

    function isOperatorAuthorized(address owner, address operator, bytes4 selector) external view returns (bool);
}
