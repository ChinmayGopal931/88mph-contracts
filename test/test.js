// Libraries
const BigNumber = require("bignumber.js");

// Contract artifacts
const DInterest = artifacts.require("DInterest");
const FeeModel = artifacts.require("FeeModel");
const AaveMarket = artifacts.require("AaveMarket");
const CompoundERC20Market = artifacts.require("CompoundERC20Market");
const CERC20Mock = artifacts.require("CERC20Mock");
const ERC20Mock = artifacts.require("ERC20Mock");
const ATokenMock = artifacts.require("ATokenMock");
const LendingPoolMock = artifacts.require("LendingPoolMock");
const LendingPoolCoreMock = artifacts.require("LendingPoolCoreMock");
const LendingPoolAddressesProviderMock = artifacts.require("LendingPoolAddressesProviderMock");

// Constants
const UIRMultiplier = BigNumber(0.5 * 1e18).integerValue().toFixed(); // Minimum safe avg interest rate multiplier
const MinDepositPeriod = 90 * 24 * 60 * 60; // 90 days in seconds
const PRECISION = 1e18;
const YEAR_IN_BLOCKS = 2104400; // Number of blocks in a year
const YEAR_IN_SEC = 31556952; // Number of seconds in a year
const epsilon = 1e-6;

// Utilities
// travel `time` seconds forward in time
function timeTravel(time) {
  return new Promise((resolve, reject) => {
    web3.currentProvider.send({
      jsonrpc: "2.0",
      method: "evm_increaseTime",
      params: [time],
      id: new Date().getTime()
    }, (err, result) => {
      if (err)
        return reject(err);
      return resolve(result)
    });
  });
}

async function latestBlockTimestamp() {
  return (await web3.eth.getBlock("latest")).timestamp;
}

function calcFeeAmount(interestAmount) {
  return interestAmount * 0.1;
}

function calcUpfrontInterestAmount(depositAmount, interestRatePerSecond, depositPeriodInSeconds) {
  const ONE = BigNumber(1);
  const interestBeforeFee = BigNumber(depositAmount).times(ONE.minus(ONE.div(ONE.plus(BigNumber(interestRatePerSecond).times(depositPeriodInSeconds).div(PRECISION).times(UIRMultiplier).div(PRECISION)))));
  return interestBeforeFee.minus(calcFeeAmount(interestBeforeFee));
}

// Converts a JS number into a string that doesn't use scientific notation
function num2str(num) {
  return BigNumber(num).integerValue().toFixed();
}

function epsilonEq(curr, prev) {
  return BigNumber(curr).eq(prev) || BigNumber(curr).minus(prev).div(prev).abs().lt(epsilon);
}

// Tests
contract("DInterest: Compound", accounts => {
  // Accounts
  let acc0 = accounts[0];
  let acc1 = accounts[1];

  // Contract instances
  let stablecoin;
  let cToken;
  let dInterestPool;
  let market;
  let feeModel;

  // Constants
  const INIT_EXRATE = 2e26; // 1 cToken = 0.02 stablecoin
  const INIT_INTEREST_RATE = 0.1; // 10% APY
  const INIT_INTEREST_RATE_PER_BLOCK = 45290900000;

  beforeEach(async function () {
    // Initialize mock stablecoin and cToken
    stablecoin = await ERC20Mock.new();
    cToken = await CERC20Mock.new(stablecoin.address);

    // Mint stablecoin
    const mintAmount = 1000 * PRECISION;
    await stablecoin.mint(cToken.address, num2str(mintAmount));
    await stablecoin.mint(acc0, num2str(mintAmount));
    await stablecoin.mint(acc1, num2str(mintAmount));

    // Initialize the money market
    market = await CompoundERC20Market.new(cToken.address, stablecoin.address);

    // Initialize the DInterest pool
    feeModel = await FeeModel.new();
    dInterestPool = await DInterest.new(UIRMultiplier, MinDepositPeriod, market.address, stablecoin.address, feeModel.address);

    // Transfer the ownership of the money market to the DInterest pool
    await market.transferOwnership(dInterestPool.address);
  });

  it("deposit()", async function () {
    const depositAmount = 100 * PRECISION;

    // acc0 deposits stablecoin into the DInterest pool for 1 year
    await stablecoin.approve(dInterestPool.address, num2str(depositAmount), { from: acc0 });
    let blockNow = await latestBlockTimestamp();
    const acc0BeforeBalance = BigNumber(await stablecoin.balanceOf(acc0));
    await dInterestPool.deposit(num2str(depositAmount), num2str(blockNow + YEAR_IN_SEC), { from: acc0 });

    // Verify upfront interest amount
    const acc0CurrentBalance = BigNumber(await stablecoin.balanceOf(acc0));
    const blocktime = BigNumber(await dInterestPool.blocktime()).div(PRECISION);
    const interestRatePerSecond = BigNumber(INIT_INTEREST_RATE_PER_BLOCK).div(blocktime);
    const upfrontInterestExpected = calcUpfrontInterestAmount(depositAmount, interestRatePerSecond, num2str(YEAR_IN_SEC)).integerValue();
    const upfrontInterestActual = acc0CurrentBalance.minus(acc0BeforeBalance).plus(depositAmount);
    // console.log(upfrontInterestActual.div(depositAmount).toFixed());
    assert(epsilonEq(upfrontInterestExpected, upfrontInterestActual), "acc0 didn't receive correct amount of upfront interest");

    // Verify totalDeposit
    const totalDeposit0 = BigNumber(await dInterestPool.totalDeposit());
    assert(totalDeposit0.eq(depositAmount), "totalDeposit not updated after acc0 deposited");
  });

  it("withdraw()", async function () {
    const depositAmount = 10 * PRECISION;

    // acc0 deposits stablecoin into the DInterest pool for 1 year
    await stablecoin.approve(dInterestPool.address, num2str(depositAmount), { from: acc0 });
    let blockNow = await latestBlockTimestamp();
    await dInterestPool.deposit(num2str(depositAmount), blockNow + YEAR_IN_SEC, { from: acc0 });

    // Wait 6 months
    await timeTravel(0.5 * YEAR_IN_SEC);

    // acc1 deposits stablecoin into the DInterest pool for 1 year
    await stablecoin.approve(dInterestPool.address, num2str(depositAmount), { from: acc1 });
    blockNow = await latestBlockTimestamp();
    await dInterestPool.deposit(num2str(depositAmount), blockNow + YEAR_IN_SEC, { from: acc1 });

    // Wait 6 months
    await timeTravel(0.5 * YEAR_IN_SEC);

    // Raise cToken exchange rate
    let rateAfter1y = INIT_EXRATE * (1 + INIT_INTEREST_RATE);
    await cToken._setExchangeRateStored(num2str(rateAfter1y));

    // acc0 withdraws
    const acc0BeforeBalance = await stablecoin.balanceOf(acc0);
    await dInterestPool.withdraw(0, 0, { from: acc0 });

    // Verify withdrawn amount
    const acc0CurrentBalance = await stablecoin.balanceOf(acc0);
    assert.equal(acc0CurrentBalance - acc0BeforeBalance, depositAmount, "acc0 didn't withdraw correct amount of stablecoin");
    // Verify totalDeposit
    const totalDeposit0 = BigNumber(await dInterestPool.totalDeposit());
    assert(totalDeposit0.eq(depositAmount), "totalDeposit not updated after acc0 withdrawed");

    // Wait 6 months
    await timeTravel(0.5 * YEAR_IN_SEC);

    // Raise cToken exchange rate
    let rateAfter1y6m = INIT_EXRATE * (1 + 1.5 * INIT_INTEREST_RATE);
    await cToken._setExchangeRateStored(num2str(rateAfter1y6m));

    // acc1 withdraws
    const acc1BeforeBalance = await stablecoin.balanceOf(acc1);
    await dInterestPool.withdraw(0, 0, { from: acc1 });

    // Verify withdrawn amount
    const acc1CurrentBalance = await stablecoin.balanceOf(acc1);
    assert.equal(acc1CurrentBalance - acc1BeforeBalance, depositAmount, "acc1 didn't withdraw correct amount of stablecoin");
    // Verify totalDeposit
    const totalDeposit1 = BigNumber(await dInterestPool.totalDeposit());
    assert(totalDeposit1.eq(0), "totalDeposit not updated after acc1 withdrawed");
  });

  it("earlyWithdraw()", async function () {
    const depositAmount = 10 * PRECISION;

    // acc0 deposits stablecoin into the DInterest pool for 1 year
    await stablecoin.approve(dInterestPool.address, num2str(depositAmount), { from: acc0 });
    let blockNow = await latestBlockTimestamp();
    await dInterestPool.deposit(num2str(depositAmount), blockNow + YEAR_IN_SEC, { from: acc0 });

    // acc0 withdraws early
    const acc0BeforeBalance = BigNumber(await stablecoin.balanceOf(acc0));
    await stablecoin.approve(dInterestPool.address, num2str(depositAmount), { from: acc0 });
    await dInterestPool.earlyWithdraw(0, 0, { from: acc0 });

    // Verify withdrawn amount
    const initialDeficit = BigNumber((await dInterestPool.userDeposits(acc0, 0)).initialDeficit);
    const acc0CurrentBalance = BigNumber(await stablecoin.balanceOf(acc0));
    assert.equal(acc0CurrentBalance.minus(acc0BeforeBalance).toNumber(), BigNumber(depositAmount).minus(initialDeficit).toNumber(), "acc0 didn't withdraw correct amount of stablecoin");
    // Verify totalDeposit
    const totalDeposit0 = BigNumber(await dInterestPool.totalDeposit());
    assert(totalDeposit0.eq(0), "totalDeposit not updated after acc0 withdrawed");
  });
});

contract("DInterest: Aave", accounts => {
  // Accounts
  let acc0 = accounts[0];
  let acc1 = accounts[1];

  // Contract instances
  let stablecoin;
  let aToken;
  let lendingPoolCore;
  let lendingPool;
  let lendingPoolAddressesProvider;
  let dInterestPool;
  let market;
  let feeModel;

  // Constants
  const INIT_INTEREST_RATE = 0.1; // 10% APY
  const INIT_INTEREST_RATE_PER_BLOCK = 45290900000;

  beforeEach(async function () {
    // Initialize mock stablecoin and Aave
    stablecoin = await ERC20Mock.new();
    aToken = await ATokenMock.new(stablecoin.address);
    lendingPoolCore = await LendingPoolCoreMock.new();
    lendingPool = await LendingPoolMock.new(lendingPoolCore.address);
    await lendingPoolCore.setLendingPool(lendingPool.address);
    await lendingPool.setReserveAToken(stablecoin.address, aToken.address);
    lendingPoolAddressesProvider = await LendingPoolAddressesProviderMock.new();
    await lendingPoolAddressesProvider.setLendingPoolImpl(lendingPool.address);
    await lendingPoolAddressesProvider.setLendingPoolCoreImpl(lendingPoolCore.address);

    // Mint stablecoin
    const mintAmount = 1000 * PRECISION;
    await stablecoin.mint(aToken.address, num2str(mintAmount));
    await stablecoin.mint(acc0, num2str(mintAmount));
    await stablecoin.mint(acc1, num2str(mintAmount));

    // Initialize the money market
    market = await AaveMarket.new(lendingPoolAddressesProvider.address, stablecoin.address);

    // Initialize the DInterest pool
    feeModel = await FeeModel.new();
    dInterestPool = await DInterest.new(UIRMultiplier, MinDepositPeriod, market.address, stablecoin.address, feeModel.address);

    // Transfer the ownership of the money market to the DInterest pool
    await market.transferOwnership(dInterestPool.address);
  });

  it("deposit()", async function () {
    const depositAmount = 100 * PRECISION;

    // acc0 deposits stablecoin into the DInterest pool for 1 year
    await stablecoin.approve(dInterestPool.address, num2str(depositAmount), { from: acc0 });
    let blockNow = await latestBlockTimestamp();
    const acc0BeforeBalance = BigNumber(await stablecoin.balanceOf(acc0));
    await dInterestPool.deposit(num2str(depositAmount), num2str(blockNow + YEAR_IN_SEC), { from: acc0 });

    // Verify upfront interest amount
    const acc0CurrentBalance = BigNumber(await stablecoin.balanceOf(acc0));
    const interestRatePerSecond = BigNumber(INIT_INTEREST_RATE).times(1e18).div(YEAR_IN_SEC);
    const upfrontInterestExpected = calcUpfrontInterestAmount(depositAmount, interestRatePerSecond, num2str(YEAR_IN_SEC)).integerValue();
    const upfrontInterestActual = acc0CurrentBalance.minus(acc0BeforeBalance).plus(depositAmount);
    //console.log(upfrontInterestExpected.div(depositAmount).toFixed());
    //console.log(upfrontInterestActual.div(depositAmount).toFixed());
    assert(epsilonEq(upfrontInterestExpected, upfrontInterestActual), "acc0 didn't receive correct amount of upfront interest");

    // Verify totalDeposit
    const totalDeposit0 = BigNumber(await dInterestPool.totalDeposit());
    assert(totalDeposit0.eq(depositAmount), "totalDeposit not updated after acc0 deposited");
  });

  it("withdraw()", async function () {
    const depositAmount = 10 * PRECISION;

    // acc0 deposits stablecoin into the DInterest pool for 1 year
    await stablecoin.approve(dInterestPool.address, num2str(depositAmount), { from: acc0 });
    let blockNow = await latestBlockTimestamp();
    await dInterestPool.deposit(num2str(depositAmount), blockNow + YEAR_IN_SEC, { from: acc0 });

    // Wait 6 months
    await timeTravel(0.5 * YEAR_IN_SEC);
    await aToken.mintInterest(num2str(0.5 * YEAR_IN_SEC));

    // acc1 deposits stablecoin into the DInterest pool for 1 year
    await stablecoin.approve(dInterestPool.address, num2str(depositAmount), { from: acc1 });
    blockNow = await latestBlockTimestamp();
    await dInterestPool.deposit(num2str(depositAmount), blockNow + YEAR_IN_SEC, { from: acc1 });

    // Wait 6 months
    await timeTravel(0.5 * YEAR_IN_SEC);
    await aToken.mintInterest(num2str(0.5 * YEAR_IN_SEC));

    // acc0 withdraws
    const acc0BeforeBalance = await stablecoin.balanceOf(acc0);
    await dInterestPool.withdraw(0, 0, { from: acc0 });

    // Verify withdrawn amount
    const acc0CurrentBalance = await stablecoin.balanceOf(acc0);
    assert.equal(acc0CurrentBalance - acc0BeforeBalance, depositAmount, "acc0 didn't withdraw correct amount of stablecoin");
    // Verify totalDeposit
    const totalDeposit0 = BigNumber(await dInterestPool.totalDeposit());
    assert(totalDeposit0.eq(depositAmount), "totalDeposit not updated after acc0 withdrawed");

    // Wait 6 months
    await timeTravel(0.5 * YEAR_IN_SEC);
    await aToken.mintInterest(num2str(0.5 * YEAR_IN_SEC));

    // acc1 withdraws
    const acc1BeforeBalance = await stablecoin.balanceOf(acc1);
    await dInterestPool.withdraw(0, 0, { from: acc1 });

    // Verify withdrawn amount
    const acc1CurrentBalance = await stablecoin.balanceOf(acc1);
    assert.equal(acc1CurrentBalance - acc1BeforeBalance, depositAmount, "acc1 didn't withdraw correct amount of stablecoin");
    // Verify totalDeposit
    const totalDeposit1 = BigNumber(await dInterestPool.totalDeposit());
    assert(totalDeposit1.eq(0), "totalDeposit not updated after acc1 withdrawed");
  });

  it("earlyWithdraw()", async function () {
    const depositAmount = 10 * PRECISION;

    // acc0 deposits stablecoin into the DInterest pool for 1 year
    await stablecoin.approve(dInterestPool.address, num2str(depositAmount), { from: acc0 });
    let blockNow = await latestBlockTimestamp();
    await dInterestPool.deposit(num2str(depositAmount), blockNow + YEAR_IN_SEC, { from: acc0 });

    // acc0 withdraws early
    const acc0BeforeBalance = BigNumber(await stablecoin.balanceOf(acc0));
    await stablecoin.approve(dInterestPool.address, num2str(depositAmount), { from: acc0 });
    await dInterestPool.earlyWithdraw(0, 0, { from: acc0 });

    // Verify withdrawn amount
    const initialDeficit = BigNumber((await dInterestPool.userDeposits(acc0, 0)).initialDeficit);
    const acc0CurrentBalance = BigNumber(await stablecoin.balanceOf(acc0));
    assert.equal(acc0CurrentBalance.minus(acc0BeforeBalance).toNumber(), BigNumber(depositAmount).minus(initialDeficit).toNumber(), "acc0 didn't withdraw correct amount of stablecoin");
    // Verify totalDeposit
    const totalDeposit0 = BigNumber(await dInterestPool.totalDeposit());
    assert(totalDeposit0.eq(0), "totalDeposit not updated after acc0 withdrawed");
  });
});