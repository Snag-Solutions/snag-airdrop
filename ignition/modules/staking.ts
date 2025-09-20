import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Deploys the LinearStake contract. Requires the ERC20 token address.
// Pass parameter via Ignition: --parameters.token=<tokenAddress>
export default buildModule("LinearStakeModule", (m) => {
  const token = m.getParameter("token");

  const stake = m.contract("LinearStake", [token]);

  return { stake };
});

