import { artifacts } from 'hardhat'
import { keccak256 } from 'viem'

async function main() {
  // 1) Read the compiled creation bytecode (including constructor)
  const artifact = await artifacts.readArtifact('SnagAirdropV2Claim')
  const creationCode = artifact.bytecode // e.g. "0x6080…"

  // 2) Compute the keccak256 hash
  //    Viem’s keccak256 will accept the hex string directly
  const hash = keccak256(creationCode as `0x${string}`)

  console.log('CLAIM_BYTECODE_HASH =', hash)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
