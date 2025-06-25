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
    chainId: await signer.getChainId(), //pass the chain id of the claim contract here
    verifyingContract: claimContract,//pass the claim contract address here
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
    id,//the id of the airdrop keccak256(new TextEncoder().encode(claim.id(uuid)))
    beneficiary,//wallet to get the tokens (addres must be in the claim list)
    totalAllocation,//number in the db
    percentageToClaim: opts.percentageToClaim, //use defined value  use 100 or v1 in the future this could be a slider
    percentageToStake: opts.percentageToStake, //for v1 always 0 
    lockupPeriod: opts.lockupPeriod,//for v1 always 0
    optionId: opts.optionId,//for v1 always keccak256(new TextEncoder().encode('full-claim'))
    router: routerAddress,// the router address is the same on all chains
  };
  const signature = await signer.signTypedData({
    account: signer.account!,
    domain,
    types,
    primaryType: "ClaimRequest",
    message,
  });
  return [id,beneficiary, proof, totalAllocation, opts, signature];
}