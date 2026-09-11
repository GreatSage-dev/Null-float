const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

async function main() {
  const networkName = hre.network.name;
  console.log("\n================================================================================");
  console.log(` NULL-FLOAT PROTOCOL DEPLOYMENT`);
  console.log(` Target Network: ${networkName} (Chain ID: ${hre.network.config.chainId || "default"})`);
  console.log("================================================================================\n");

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    console.error("FATAL: No deployer account configured. Set PRIVATE_KEY in .env");
    process.exit(1);
  }

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer Address: ${deployer.address}`);
  console.log(`Account Balance:  ${ethers.formatEther(balance)} STT / ETH\n`);

  let dexAddress = process.env.DREAMDEX_SPOT_POOL;
  const somniaPrecompile = "0x0000000000000000000000000000000000000100";

  // If on local network or no live SpotPool provided, deploy MockDreamDEX
  if (!dexAddress || networkName === "hardhat" || networkName === "localhost") {
    console.log("[1/5] Deploying MockDreamDEX for testing/local execution...");
    const MockDreamDEX = await ethers.getContractFactory("MockDreamDEX");
    const dex = await MockDreamDEX.deploy(deployer.address);
    await dex.waitForDeployment();
    dexAddress = await dex.getAddress();
    console.log(`  -> MockDreamDEX deployed at: ${dexAddress}`);
  } else {
    console.log(`[1/5] Using configured dreamDEX SpotPool at: ${dexAddress}`);
  }

  // Deploy Logger
  console.log("[2/5] Deploying NullFloatLogger...");
  const NullFloatLogger = await ethers.getContractFactory("NullFloatLogger");
  const logger = await NullFloatLogger.deploy(deployer.address);
  await logger.waitForDeployment();
  const loggerAddress = await logger.getAddress();
  console.log(`  -> NullFloatLogger deployed at: ${loggerAddress}`);

  // Deploy Clearinghouse
  console.log("[3/5] Deploying NullFloatClearing...");
  const NullFloatClearing = await ethers.getContractFactory("NullFloatClearing");
  const clearing = await NullFloatClearing.deploy();
  await clearing.waitForDeployment();
  const clearingAddress = await clearing.getAddress();
  console.log(`  -> NullFloatClearing deployed at: ${clearingAddress}`);

  // Deploy Vault
  console.log("[4/5] Deploying NullFloatVault...");
  const NullFloatVault = await ethers.getContractFactory("NullFloatVault");
  const vault = await NullFloatVault.deploy(clearingAddress);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log(`  -> NullFloatVault deployed at: ${vaultAddress}`);

  // Wiring and Initialization
  console.log("[5/5] Initializing Clearinghouse and setting authorizations...");
  const initTx = await clearing.initialize(vaultAddress, dexAddress, loggerAddress);
  await initTx.wait();

  const setLoggerTx = await logger.setClearinghouse(clearingAddress);
  await setLoggerTx.wait();

  // If using Mock DEX, authorize clearinghouse
  if (networkName === "hardhat" || networkName === "localhost" || !process.env.DREAMDEX_SPOT_POOL) {
    const dexContract = await ethers.getContractAt("MockDreamDEX", dexAddress);
    const setDexTx = await dexContract.setClearinghouse(clearingAddress);
    await setDexTx.wait();
  }

  console.log("\n================================================================================");
  console.log(" DEPLOYMENT COMPLETE & VERIFIED");
  console.log("================================================================================");
  const deploymentInfo = {
    network: networkName,
    chainId: hre.network.config.chainId || 31337,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      NullFloatClearing: clearingAddress,
      NullFloatVault: vaultAddress,
      NullFloatLogger: loggerAddress,
      DreamDEXSpotPool: dexAddress,
      SomniaReactivityPrecompile: somniaPrecompile
    }
  };

  console.log(JSON.stringify(deploymentInfo, null, 2));

  const outPath = path.join(__dirname, "..", "deployed_addresses.json");
  fs.writeFileSync(outPath, JSON.stringify(deploymentInfo, null, 2));
  console.log(`\nDeployment details written to: ${outPath}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
