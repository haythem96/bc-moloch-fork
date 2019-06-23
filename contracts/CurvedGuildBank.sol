pragma solidity ^0.4.24;

import "./oz/Ownable.sol";
import "./oz/SafeMath.sol";
import "./BondingCurve.sol";

contract CurvedGuildBank is BondingCurve {
    using SafeMath for uint256;

    event Withdrawal(address indexed receiver, uint256 amount);

    constructor(
        string memory name,
        string memory symbol,
        uint32 _reserveRatio
    ) public BondingCurve(name, symbol, _reserveRatio) {
    }

    function withdraw(address receiver, uint256 shares, uint256 totalShares) public onlyOwner returns (bool) {
        uint256 amount = balanceOf(msg.sender).mul(shares).div(totalShares);
        emit Withdrawal(receiver, amount);
        return transfer(receiver, amount);
    }
}
