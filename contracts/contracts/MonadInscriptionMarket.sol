// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MonadInscriptionMarket
 * @notice Non-custodial peer-to-peer marketplace for MON-20 inscriptions on Monad.
 *
 * Settlement model:
 *  - Sellers create on-chain listings declaring (tick, amount, priceWei).
 *  - Buyers call `buy(id)` with msg.value == priceWei.
 *  - The contract splits payment: FEE_BPS to `feeRecipient`, the remainder to
 *    the seller. The seller is then expected to push a `transfer` inscription
 *    to the buyer off-chain (the inscription protocol is not an ERC20).
 *  - All state transitions emit indexable events.
 *
 * Security:
 *  - Reentrancy guarded via Checks-Effects-Interactions: `active` flips to
 *    false BEFORE any external calls.
 *  - Payments use low-level `call` with explicit success checks.
 */
contract MonadInscriptionMarket {
    /// @notice Recipient of marketplace fees.
    address public immutable feeRecipient;

    /// @notice Fee in basis points (1/10_000). 500 = 5%.
    uint16 public constant FEE_BPS = 500;
    uint16 public constant BPS_DENOM = 10_000;

    struct Listing {
        address seller;     // 20 bytes
        uint96  priceWei;   // 12 bytes — packs into one slot with seller
        bytes32 tick;       // human-readable ticker (e.g. "BOB")
        uint256 amount;     // off-chain inscription amount
        bool    active;
    }

    /// @notice Auto-incrementing listing id.
    uint256 public nextId = 1;

    /// @notice id => listing.
    mapping(uint256 => Listing) public listings;

    event Listed(
        uint256 indexed id,
        address indexed seller,
        bytes32 indexed tick,
        uint256 amount,
        uint96  priceWei
    );

    event Sold(
        uint256 indexed id,
        address indexed buyer,
        address indexed seller,
        bytes32 tick,
        uint256 amount,
        uint96  priceWei,
        uint256 feePaid
    );

    event Cancelled(uint256 indexed id, address indexed seller);

    error InactiveListing();
    error NotSeller();
    error WrongPrice();
    error PaymentFailed();
    error InvalidInput();

    constructor(address _feeRecipient) {
        if (_feeRecipient == address(0)) revert InvalidInput();
        feeRecipient = _feeRecipient;
    }

    /**
     * @notice Create a listing.
     * @param tick     Inscription ticker, e.g. bytes32("BOB").
     * @param amount   Off-chain inscription amount being sold.
     * @param priceWei Total price in wei (MON).
     * @return id      The newly created listing id.
     */
    function list(bytes32 tick, uint256 amount, uint96 priceWei)
        external
        returns (uint256 id)
    {
        if (priceWei == 0 || amount == 0 || tick == bytes32(0)) revert InvalidInput();
        id = nextId++;
        listings[id] = Listing({
            seller:   msg.sender,
            priceWei: priceWei,
            tick:     tick,
            amount:   amount,
            active:   true
        });
        emit Listed(id, msg.sender, tick, amount, priceWei);
    }

    /**
     * @notice Buy an active listing. Pays seller (95%) and feeRecipient (5%).
     * @dev Reverts unless msg.value matches the listed priceWei exactly.
     */
    function buy(uint256 id) external payable {
        Listing storage l = listings[id];
        if (!l.active) revert InactiveListing();
        if (msg.value != uint256(l.priceWei)) revert WrongPrice();

        // Effects: flip state before any external call (reentrancy-safe).
        l.active = false;
        address seller = l.seller;
        bytes32 tick   = l.tick;
        uint256 amount = l.amount;
        uint96  price  = l.priceWei;

        uint256 fee = (uint256(price) * FEE_BPS) / BPS_DENOM;
        uint256 sellerAmt = uint256(price) - fee;

        // Interactions
        (bool okFee,) = payable(feeRecipient).call{value: fee}("");
        if (!okFee) revert PaymentFailed();
        (bool okSeller,) = payable(seller).call{value: sellerAmt}("");
        if (!okSeller) revert PaymentFailed();

        emit Sold(id, msg.sender, seller, tick, amount, price, fee);
    }

    /**
     * @notice Cancel an active listing. Callable only by the seller.
     */
    function cancel(uint256 id) external {
        Listing storage l = listings[id];
        if (!l.active) revert InactiveListing();
        if (l.seller != msg.sender) revert NotSeller();
        l.active = false;
        emit Cancelled(id, msg.sender);
    }

    /// @notice Quote helper. Returns (sellerAmt, feeAmt) for a given price.
    function quote(uint96 priceWei) external pure returns (uint256 sellerAmt, uint256 feeAmt) {
        feeAmt = (uint256(priceWei) * FEE_BPS) / BPS_DENOM;
        sellerAmt = uint256(priceWei) - feeAmt;
    }
}
