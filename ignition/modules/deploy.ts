import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("AirdropFactoryModule", (m) => {
  // Protocol admin for the factory constructor.
  // Provide via Ignition parameters: --parameters.protocolAdmin=<address>
  const protocolAdmin = m.getParameter("protocolAdmin");

  // Deploy the SnagAirdropV2Factory (constructor requires protocolAdmin)
  const factory = m.contract("SnagAirdropV2Factory", [protocolAdmin]);

  return { factory };
});
