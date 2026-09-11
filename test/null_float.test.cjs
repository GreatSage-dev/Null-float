const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("NULL-FLOAT: Continuous Net Settlement Protocol", function () {
  let deployer, lpUser, trader, attacker;
  let logger, dex, vault, clearing, priceStream;

  const PRECOMPILE_ADDR = "0x0000000000000000000000000000000000000100";

  beforeEach(async function () {
    [deployer, lpUser, trader, attacker] = await ethers.getSigners();

    // 1. Deploy Logger
    const Logger = await ethers.getContractFactory("NullFloatLogger");
    // Temporary clearinghouse address
    logger = await Logger.deploy(deployer.address);
    await logger.waitForDeployment();

    // 2. Deploy MockDreamDEX
    const MockDEX = await ethers.getContractFactory("MockDreamDEX");
    dex = await MockDEX.deploy(deployer.address);
    await dex.waitForDeployment();

    // 3. Deploy Clearinghouse
    const Clearing = await ethers.getContractFactory("NullFloatClearing");
    clearing = await Clearing.deploy();
    await clearing.waitForDeployment();

    // 4. Deploy Vault
    const Vault = await ethers.getContractFactory("NullFloatVault");
    vault = await Vault.deploy(await clearing.getAddress());
    await vault.waitForDeployment();

    // 5. Deploy MockPriceStream
    const Stream = await ethers.getContractFactory("MockPriceStream");
    priceStream = await Stream.deploy();
    await priceStream.waitForDeployment();

    // 6. Initialize Clearinghouse & Wire up Logger & DEX
    await clearing.initialize(
      await vault.getAddress(),
      await dex.getAddress(),
      await logger.getAddress()
    );

    await logger.setClearinghouse(await clearing.getAddress());
    await dex.setClearinghouse(await clearing.getAddress());
  });

  describe("1. Architectural Initialization & Auth", function () {
    it("should correctly wire clearinghouse, vault, and logger", async function () {
      expect(await clearing.vault()).to.equal(await vault.getAddress());
      expect(await clearing.spotPool()).to.equal(await dex.getAddress());
      expect(await clearing.logger()).to.equal(await logger.getAddress());
      expect(await clearing.owner()).to.equal(deployer.address);
    });

    it("should prevent double initialization", async function () {
      await expect(
        clearing.initialize(
          await vault.getAddress(),
          await dex.getAddress(),
          await logger.getAddress()
        )
      ).to.be.revertedWith("NullFloatClearing: already initialized");
    });

    it("should reject non-precompile caller on onEvent", async function () {
      const topics = [
        ethers.keccak256(ethers.toUtf8Bytes("WindowSettlement()")),
        ethers.zeroPadValue(ethers.toBeHex(100), 32)
      ];
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256", "bool"],
        [101, ethers.parseEther("65000"), ethers.parseEther("65000"), true]
      );

      // Attacker tries to invoke onEvent
      await expect(
        clearing.connect(attacker).onEvent(await priceStream.getAddress(), topics, data)
      ).to.be.revertedWith("NullFloatClearing: unauthorized caller, not 0x0100");
    });
  });

  describe("2. Non-Custodial Vault Mechanics", function () {
    it("should allow users to deposit collateral and mint shares", async function () {
      const depositAmount = ethers.parseEther("10.0");
      await vault.connect(lpUser).deposit({ value: depositAmount });

      expect(await vault.balanceOf(lpUser.address)).to.equal(depositAmount);
      expect(await vault.totalAssets()).to.equal(depositAmount);
      expect(await vault.totalSupply()).to.equal(depositAmount);
    });

    it("should allow users to withdraw their collateral and burn shares", async function () {
      const depositAmount = ethers.parseEther("5.0");
      await vault.connect(lpUser).deposit({ value: depositAmount });

      const balBefore = await ethers.provider.getBalance(lpUser.address);
      const tx = await vault.connect(lpUser).withdraw(depositAmount, lpUser.address);
      const receipt = await tx.wait();
      const gasSpent = receipt.gasUsed * receipt.gasPrice;

      const balAfter = await ethers.provider.getBalance(lpUser.address);
      expect(balAfter + gasSpent - balBefore).to.equal(depositAmount);
      expect(await vault.balanceOf(lpUser.address)).to.equal(0n);
    });

    it("should prevent unauthorized callers from pulling capital", async function () {
      await vault.connect(lpUser).deposit({ value: ethers.parseEther("5.0") });

      await expect(
        vault.connect(attacker).pullCapital(ethers.parseEther("1.0"))
      ).to.be.revertedWith("NullFloatVault: caller not clearinghouse");
    });

    it("should correctly distribute returned spread to vault shares", async function () {
      await vault.connect(lpUser).deposit({ value: ethers.parseEther("10.0") });

      // Owner/Clearing returns 1.0 ETH spread
      await vault.connect(deployer).returnCapital(0, ethers.parseEther("1.0"), {
        value: ethers.parseEther("1.0")
      });

      expect(await vault.totalAssets()).to.equal(ethers.parseEther("11.0"));
    });
  });

  describe("3. The Discontinuity Quarantine (The Refusal)", function () {
    it("should activate quarantine and REFUSE rollover if Spot/EMA diverge > 3.5%", async function () {
      // Deposit vault capital
      await vault.connect(lpUser).deposit({ value: ethers.parseEther("50.0") });

      const closedWindowId = 100;
      const nextWindowId = 101;
      const spotPrice = ethers.parseEther("68000"); // 4.6% spike above EMA
      const emaPrice  = ethers.parseEther("65000");

      const topics = [
        ethers.keccak256(ethers.toUtf8Bytes("WindowSettlement()")),
        ethers.zeroPadValue(ethers.toBeHex(closedWindowId), 32)
      ];
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256", "bool"],
        [nextWindowId, spotPrice, emaPrice, true]
      );

      // Deployer invokes onEvent (allowed as owner/mock precompile)
      const tx = await clearing.onEvent(deployer.address, topics, data);
      await expect(tx).to.emit(clearing, "QuarantineActivated");

      // Verify no orders placed in next window
      expect(await clearing.currentActiveWindowId()).to.equal(0n);
    });

    it("should refuse and quarantine when spot or ema oracle reports zero", async function () {
      await vault.connect(lpUser).deposit({ value: ethers.parseEther("50.0") });

      const topics = [
        ethers.keccak256(ethers.toUtf8Bytes("WindowSettlement()")),
        ethers.zeroPadValue(ethers.toBeHex(100), 32)
      ];
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256", "bool"],
        [101, 0, ethers.parseEther("65000"), true] // Spot is zero
      );

      const tx = await clearing.onEvent(deployer.address, topics, data);
      await expect(tx).to.emit(clearing, "QuarantineActivated");
      expect(await clearing.currentActiveWindowId()).to.equal(0n);
    });

    it("should proceed with rollover if Spot/EMA divergence is normal (<= 3.5%)", async function () {
      await vault.connect(lpUser).deposit({ value: ethers.parseEther("50.0") });

      const closedWindowId = 100;
      const nextWindowId = 101;
      const spotPrice = ethers.parseEther("65100"); // 0.15% divergence
      const emaPrice  = ethers.parseEther("65000");

      const topics = [
        ethers.keccak256(ethers.toUtf8Bytes("WindowSettlement()")),
        ethers.zeroPadValue(ethers.toBeHex(closedWindowId), 32)
      ];
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256", "bool"],
        [nextWindowId, spotPrice, emaPrice, true]
      );

      const tx = await clearing.onEvent(deployer.address, topics, data);
      await expect(tx).to.emit(clearing, "RolloverCompleted");

      expect(await clearing.currentActiveWindowId()).to.equal(BigInt(nextWindowId));
    });
  });

  describe("4. Continuous Net Settlement Invariants", function () {
    it("should compute exact ATM parity bids at t=0 (p = 0.500 - Delta)", async function () {
      await vault.connect(lpUser).deposit({ value: ethers.parseEther("50.0") });

      const closedWindowId = 100;
      const nextWindowId = 101;
      const spotPrice = ethers.parseEther("65000");
      const emaPrice  = ethers.parseEther("65000");

      const topics = [
        ethers.keccak256(ethers.toUtf8Bytes("WindowSettlement()")),
        ethers.zeroPadValue(ethers.toBeHex(closedWindowId), 32)
      ];
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256", "bool"],
        [nextWindowId, spotPrice, emaPrice, true]
      );

      await clearing.onEvent(deployer.address, topics, data);

      // Orders #1001 (YES) and #1002 (NO) placed in MockDreamDEX
      const orderYes = await dex.getOrder(1001);
      const orderNo  = await dex.getOrder(1002);

      // Spread default = 100 bps (1.00%), ATM = 0.500 -> Bid = 0.495
      const expectedBidPrice = ethers.parseEther("0.495");
      expect(orderYes.price).to.equal(expectedBidPrice);
      expect(orderNo.price).to.equal(expectedBidPrice);

      // Zero-Inventory Check: YES quantity == NO quantity
      expect(orderYes.fullQuantity).to.equal(orderNo.fullQuantity);
      expect(orderYes.isBid).to.be.true;
      expect(orderNo.isBid).to.be.false;
    });

    it("should prove 0-block float latency (Delta b = 0)", async function () {
      await vault.connect(lpUser).deposit({ value: ethers.parseEther("50.0") });

      const closedWindowId = 200;
      const nextWindowId = 201;

      const topics = [
        ethers.keccak256(ethers.toUtf8Bytes("WindowSettlement()")),
        ethers.zeroPadValue(ethers.toBeHex(closedWindowId), 32)
      ];
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256", "bool"],
        [nextWindowId, ethers.parseEther("65000"), ethers.parseEther("65000"), true]
      );

      const tx = await clearing.onEvent(deployer.address, topics, data);
      const receipt = await tx.wait();

      // Check logger record
      expect(await clearing.lastRolloverBlock()).to.equal(receipt.blockNumber);
    });
  });

  describe("5. Emergency Admin Controls", function () {
    it("should respect emergency pause", async function () {
      await clearing.togglePause();
      expect(await clearing.isPaused()).to.be.true;

      const topics = [
        ethers.keccak256(ethers.toUtf8Bytes("WindowSettlement()")),
        ethers.zeroPadValue(ethers.toBeHex(100), 32)
      ];
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256", "bool"],
        [101, ethers.parseEther("65000"), ethers.parseEther("65000"), true]
      );

      await expect(
        clearing.onEvent(deployer.address, topics, data)
      ).to.be.revertedWith("NullFloatClearing: clearinghouse paused");
    });

    it("should enforce spread boundaries (10 bps to 500 bps)", async function () {
      await expect(clearing.setSpreadBps(5)).to.be.revertedWith("NullFloatClearing: spread out of bounds");
      await expect(clearing.setSpreadBps(600)).to.be.revertedWith("NullFloatClearing: spread out of bounds");

      await clearing.setSpreadBps(250);
      expect(await clearing.defaultSpreadBps()).to.equal(250n);
    });

    it("should reject zero deposits and zero withdrawals in vault", async function () {
      await expect(vault.connect(lpUser).deposit({ value: 0 })).to.be.revertedWith("NullFloatVault: deposit zero");
      await expect(vault.connect(lpUser).withdraw(0, lpUser.address)).to.be.revertedWith("NullFloatVault: withdraw zero");
    });

    it("should reject withdrawal to zero address", async function () {
      await vault.connect(lpUser).deposit({ value: ethers.parseEther("1.0") });
      await expect(
        vault.connect(lpUser).withdraw(ethers.parseEther("1.0"), ethers.ZeroAddress)
      ).to.be.revertedWith("NullFloatVault: invalid receiver");
    });

    it("should dynamically deploy available capital if vault balance is under maxRolloverSize", async function () {
      // Deposit only 20 ETH (less than default 50 ETH maxRolloverSize)
      await vault.connect(lpUser).deposit({ value: ethers.parseEther("20.0") });

      const topics = [
        ethers.keccak256(ethers.toUtf8Bytes("WindowSettlement()")),
        ethers.zeroPadValue(ethers.toBeHex(100), 32)
      ];
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256", "bool"],
        [101, ethers.parseEther("65000"), ethers.parseEther("65000"), true]
      );

      // Should succeed and deploy the available 20 ETH instead of reverting
      const tx = await clearing.onEvent(deployer.address, topics, data);
      await expect(tx).to.emit(clearing, "RolloverCompleted");
      expect(await clearing.currentActiveWindowId()).to.equal(101n);
    });
  });

  describe("6. Multi-Window Continuous Rollover Cascade", function () {
    it("should execute 3 consecutive window rollovers with zero float latency", async function () {
      // Deposit 150 ETH to fund 3 consecutive rollovers (50 ETH each)
      await vault.connect(lpUser).deposit({ value: ethers.parseEther("150.0") });

      // Window 1 -> Window 2
      let topics = [
        ethers.keccak256(ethers.toUtf8Bytes("WindowSettlement()")),
        ethers.zeroPadValue(ethers.toBeHex(1), 32)
      ];
      let data = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256", "bool"],
        [2, ethers.parseEther("65000"), ethers.parseEther("65000"), true]
      );
      await clearing.onEvent(deployer.address, topics, data);
      expect(await clearing.currentActiveWindowId()).to.equal(2n);

      // Window 2 -> Window 3
      topics[1] = ethers.zeroPadValue(ethers.toBeHex(2), 32);
      data = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256", "bool"],
        [3, ethers.parseEther("65200"), ethers.parseEther("65150"), false]
      );
      await clearing.onEvent(deployer.address, topics, data);
      expect(await clearing.currentActiveWindowId()).to.equal(3n);

      // Window 3 -> Window 4
      topics[1] = ethers.zeroPadValue(ethers.toBeHex(3), 32);
      data = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256", "bool"],
        [4, ethers.parseEther("65300"), ethers.parseEther("65280"), true]
      );
      await clearing.onEvent(deployer.address, topics, data);
      expect(await clearing.currentActiveWindowId()).to.equal(4n);

      // Verify logger recorded 3 complete rollovers
      expect(await logger.totalRollovers()).to.equal(3n);
      const r1 = await logger.getRollover(1);
      const r2 = await logger.getRollover(2);
      const r3 = await logger.getRollover(3);
      expect(r1.floatLatencyBlocks).to.equal(0n);
      expect(r2.floatLatencyBlocks).to.equal(0n);
      expect(r3.floatLatencyBlocks).to.equal(0n);
    });
  });
});
