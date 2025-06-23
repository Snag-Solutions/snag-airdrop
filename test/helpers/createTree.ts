import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { parseEther } from "viem";

export const claimList: [string, bigint][] = [
  ["0x1111111111111111111111111111111111111111", parseEther("100")],
  ["0x2222222222222222222222222222222222222222", parseEther("50")],
];

export const tree = StandardMerkleTree.of(claimList, ["address", "uint256"]);
export const root = tree.root;


const main = async () => {
  console.log(root);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});