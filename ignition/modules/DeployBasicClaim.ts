import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { zeroAddress } from "viem";

export default buildModule("BasicClaimModule", (m) => {
  // grab the precomputed root & asset from CLI
  const root         = m.getParameter<string>("root");
  const assetAddress = m.getParameter<string>("assetAddress", zeroAddress);

  // no staking, zero multiplier/durations
  const claim = m.contract("SnagAirdropClaim", [
    root,
    assetAddress,
    zeroAddress, // stakingAddress
    0,    // multiplier
    0,    // minLockupDuration
    0,    // minLockupDurationForMultiplier
  ]);

  return { claim };
});