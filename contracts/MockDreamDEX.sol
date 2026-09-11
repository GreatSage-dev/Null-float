// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/ISpotPool.sol";

/// @title MockDreamDEX - Emulated dreamDEX Spot Pool & Binary Market Module
/// @notice Simulates order placement, parity minting, cancellation, and window redemption for testing.
contract MockDreamDEX is ISpotPool {
    struct Order {
        uint128 orderId;
        bool isBid;
        address owner;
        uint64 userData;
        uint256 price;
        uint256 fullQuantity;
        uint256 quantityRemaining;
        uint64 expireTimestampNs;
        bool active;
        bool cancelled;
        bool filled;
    }

    uint128 public nextOrderId = 1001;
    mapping(uint128 => Order) public orders;
    mapping(address => mapping(address => bool)) public operatorApprovals;
    address public clearinghouse;

    // Window tracking
    mapping(uint256 => bool) public windowSettled;
    mapping(uint256 => uint256) public windowPayoutPool;

    event OrderPlaced(uint128 indexed orderId, address indexed owner, bool isBid, uint256 price, uint256 quantity);
    event OrderCancelled(uint128 indexed orderId, address indexed owner);
    event WindowRedeemed(uint256 indexed windowId, address indexed redeemer, uint256 amount);

    constructor(address _clearinghouse) {
        clearinghouse = _clearinghouse;
    }

    function setClearinghouse(address _clearinghouse) external {
        clearinghouse = _clearinghouse;
    }

    function setOperatorApproval(address operator, bool approved) external {
        operatorApprovals[msg.sender][operator] = approved;
    }

    function placeOrder(
        bool isBid,
        uint64 userData,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 /* orderType */,
        uint8 /* selfMatchingOption */,
        address /* builder */,
        uint96 /* builderFeeBpsTimes1k */
    ) external payable override returns (bool success, uint128 orderId) {
        orderId = nextOrderId++;
        orders[orderId] = Order({
            orderId: orderId,
            isBid: isBid,
            owner: msg.sender,
            userData: userData,
            price: price,
            fullQuantity: quantity,
            quantityRemaining: quantity,
            expireTimestampNs: expireTimestampNs,
            active: true,
            cancelled: false,
            filled: false
        });

        emit OrderPlaced(orderId, msg.sender, isBid, price, quantity);
        return (true, orderId);
    }

    function placeOrderFor(
        address owner,
        bool isBid,
        uint64 userData,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 /* orderType */,
        uint8 /* selfMatchingOption */,
        address /* builder */,
        uint96 /* builderFeeBpsTimes1k */
    ) external payable override returns (bool success, uint128 orderId) {
        require(
            msg.sender == owner || operatorApprovals[owner][msg.sender] || msg.sender == clearinghouse,
            "MockDreamDEX: unauthorized operator"
        );

        orderId = nextOrderId++;
        orders[orderId] = Order({
            orderId: orderId,
            isBid: isBid,
            owner: owner,
            userData: userData,
            price: price,
            fullQuantity: quantity,
            quantityRemaining: quantity,
            expireTimestampNs: expireTimestampNs,
            active: true,
            cancelled: false,
            filled: false
        });

        emit OrderPlaced(orderId, owner, isBid, price, quantity);
        return (true, orderId);
    }

    function cancelOrder(uint128 orderId) external override {
        Order storage order = orders[orderId];
        require(order.owner == msg.sender, "MockDreamDEX: not owner");
        order.active = false;
        order.cancelled = true;
        emit OrderCancelled(orderId, msg.sender);
    }

    function cancelOrderFor(address owner, uint128 orderId) external override {
        require(
            msg.sender == owner || operatorApprovals[owner][msg.sender] || msg.sender == clearinghouse,
            "MockDreamDEX: unauthorized"
        );
        Order storage order = orders[orderId];
        order.active = false;
        order.cancelled = true;
        emit OrderCancelled(orderId, owner);
    }

    function reduceOrder(uint128 orderId, uint256 newQuantityRemaining) external override {
        Order storage order = orders[orderId];
        require(order.owner == msg.sender, "MockDreamDEX: not owner");
        order.quantityRemaining = newQuantityRemaining;
    }

    function getOrder(uint128 orderId) external view override returns (OrderInfo memory) {
        Order memory o = orders[orderId];
        return OrderInfo({
            orderId: o.orderId,
            isBid: o.isBid,
            owner: o.owner,
            userData: o.userData,
            price: o.price,
            fullQuantity: o.fullQuantity,
            quantityRemaining: o.quantityRemaining,
            expireTimestampNs: o.expireTimestampNs
        });
    }

    function isOperatorAuthorized(address owner, address operator, bytes4 /* selector */) external view override returns (bool) {
        return operatorApprovals[owner][operator] || operator == clearinghouse;
    }

    function redeem(uint256 windowId) external returns (uint256 payout) {
        payout = windowPayoutPool[windowId];
        if (payout > 0) {
            windowPayoutPool[windowId] = 0;
            (bool sent, ) = msg.sender.call{value: payout}("");
            require(sent, "MockDreamDEX: payout transfer failed");
            emit WindowRedeemed(windowId, msg.sender, payout);
        }
    }

    function seedWindowPayout(uint256 windowId) external payable {
        windowPayoutPool[windowId] += msg.value;
    }

    receive() external payable {}
}
