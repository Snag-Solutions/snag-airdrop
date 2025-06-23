import { WalletClient } from "viem";

export type ClaimOptions = {
  optionId: `0x${string}`;
  percentageToClaim: number;
  percentageToStake: number;
  lockupPeriod: number;
};

interface ClaimParams {
  id: `0x${string}`;
  proof: `0x${string}`[];
  totalAllocation: bigint;
  opts: ClaimOptions;
}

/**
 * Returns [id, proof, totalAllocation, opts, signature]
 */
export async function makeClaimArgs(
  signer: WalletClient,
  { id, proof, totalAllocation, opts }: ClaimParams,
  claimContract: `0x${string}`,
  routerAddress: `0x${string}`
): Promise<
  [
    `0x${string}`,
    `0x${string}`[],
    bigint,
    ClaimOptions,
    `0x${string}`
  ]
> {
  const beneficiary = signer.account?.address!;
  const domain = {
    name: "SnagAirdropClaim",
    version: "1",
    chainId: await signer.getChainId(),
    verifyingContract: claimContract,
  };
  const types = {
    ClaimRequest: [
      { name: "id",                type: "bytes32" },
      { name: "beneficiary",       type: "address" },
      { name: "totalAllocation",   type: "uint256" },
      { name: "percentageToClaim", type: "uint8" },
      { name: "percentageToStake", type: "uint8" },
      { name: "lockupPeriod",      type: "uint32" },
      { name: "optionId",          type: "bytes32" },
      { name: "router",            type: "address" }
    ]
  };
  const message = {
    id,
    beneficiary,
    totalAllocation,
    percentageToClaim: opts.percentageToClaim,
    percentageToStake: opts.percentageToStake,
    lockupPeriod: opts.lockupPeriod,
    optionId: opts.optionId,
    router: routerAddress,
  };
  const signature = await signer.signTypedData({
    account: signer.account!,
    domain,
    types,
    primaryType: "ClaimRequest",
    message,
  });
  return [id, proof, totalAllocation, opts, signature];
}