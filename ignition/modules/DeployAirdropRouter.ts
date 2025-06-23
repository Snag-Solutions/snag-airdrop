import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("AirdropRouterModule", (m) => {
  // Deploy the SnagAirdropRouter (no constructor args)
  const router = m.contract("SnagAirdropRouter", []);

  return { router };
});