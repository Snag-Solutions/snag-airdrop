import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";
import 'solidity-coverage';
import '@primitivefi/hardhat-dodoc';
import * as dotenv from "dotenv";

dotenv.config()
const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
    ],
  },
  ignition: {
    strategyConfig: {
      create2: {
        // pick any 32-byte hex string; this salt + bytecode
        // deterministically yields the same address everywhere
        //echo "0x$(openssl rand -hex 32)"
        salt: "0x29327956f4cecc0db57f4216f238b69db67992bc3a8122a2404af95de6898895",
      },
    },
  },
  dodoc: {
    runOnCompile: true,
    exclude: ['contracts/test/**']
  },
  networks: {
    // For CI/local tests, avoid invalid accounts if env vars are missing
    // Provide accounts only when DEPLOYER_PRIVATE_KEY is set
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    // get _accounts() { return process.env.DEPLOYER_PRIVATE_KEY ? [`0x${process.env.DEPLOYER_PRIVATE_KEY}`] : undefined },
    // goerli: {
    //   url: `${process.env.ALCHEMY_GOERLI_URL}`,
    //   // @ts-ignore
    //   accounts: (process.env.DEPLOYER_PRIVATE_KEY ? [`0x${process.env.DEPLOYER_PRIVATE_KEY}`] : undefined),
    // },
    // base: {
    //   url: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
    //   // @ts-ignore
    //   accounts: (process.env.DEPLOYER_PRIVATE_KEY ? [`0x${process.env.DEPLOYER_PRIVATE_KEY}`] : undefined),
    // },
    // baseSepolia: {
    //   url: `https://base-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
    //   // @ts-ignore
    //   accounts: (process.env.DEPLOYER_PRIVATE_KEY ? [`0x${process.env.DEPLOYER_PRIVATE_KEY}`] : undefined),
    // },
    // ethereum: {
    //   url: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
    //   // @ts-ignore
    //   accounts: (process.env.DEPLOYER_PRIVATE_KEY ? [`0x${process.env.DEPLOYER_PRIVATE_KEY}`] : undefined),
    // },
    // sepolia: {
    //   url: `https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
    // },
    // arbitrum: {
    //   url: `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
    //   // @ts-ignore
    //   accounts: (process.env.DEPLOYER_PRIVATE_KEY ? [`0x${process.env.DEPLOYER_PRIVATE_KEY}`] : undefined),
    // },
    // arbitrumSepolia: {
    //   url: `https://arb-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
    //   // @ts-ignore
    //   accounts: (process.env.DEPLOYER_PRIVATE_KEY ? [`0x${process.env.DEPLOYER_PRIVATE_KEY}`] : undefined),
    // },
    // flow: {
    //   url: `https://flow-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
    //   // @ts-ignore
    //   accounts: (process.env.DEPLOYER_PRIVATE_KEY ? [`0x${process.env.DEPLOYER_PRIVATE_KEY}`] : undefined),
    // },
    // flowTestnet: {
    //   url: `https://flow-testnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
    //   // @ts-ignore
    //   accounts: (process.env.DEPLOYER_PRIVATE_KEY ? [`0x${process.env.DEPLOYER_PRIVATE_KEY}`] : undefined),
    // },
    // apechain: {
    //   url: `https://apecoin-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
    //   // @ts-ignore
    //   accounts: (process.env.DEPLOYER_PRIVATE_KEY ? [`0x${process.env.DEPLOYER_PRIVATE_KEY}`] : undefined),
    // }
  }
};

export default config;
