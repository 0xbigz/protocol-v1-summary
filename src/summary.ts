import { Connection, Keypair, PublicKey } from '@solana/web3.js';

import {
	BN,
	ClearingHouse,
	initialize,
	PositionDirection,
	AMM_TO_QUOTE_PRECISION_RATIO,
	convertToNumber,
	AMM_RESERVE_PRECISION,
	MARK_PRICE_PRECISION,
	QUOTE_PRECISION,
	Markets,
	ZERO,
	getSwapDirection,
	calculateAmmReservesAfterSwap,
	calculateBaseAssetValue,
	calculatePositionPNL,
	PEG_PRECISION,
	Wallet,
	UserPosition,
	Market,
} from '@drift-labs/sdk';

/**
 * Calculates how much to increase k given the cost of the operation
 * @param market
 * @param cost
 */
function calculateBudgetedK(market: Market, cost: BN): [BN, BN] {
	// wolframalpha.com
	// (1/(x+d) - p/(x*p+d))*y*d*Q = C solve for p
	// p = (d(y*d*Q - C(x+d))) / (C*x(x+d) + y*y*d*Q)

	// todo: assumes k = x * y
	// otherwise use: (y(1-p) + (kp^2/(x*p+d)) - k/(x+d)) * Q = C solve for p

	const x = market.amm.baseAssetReserve;
	const y = market.amm.quoteAssetReserve;

	const d = market.baseAssetAmount;
	const Q = market.amm.pegMultiplier;

	const C = cost.mul(new BN(-1));

	const numer1 = y.mul(d).mul(Q).div(AMM_RESERVE_PRECISION).div(PEG_PRECISION);
	const numer2 = C.mul(x.add(d)).div(QUOTE_PRECISION);
	const denom1 = C.mul(x)
		.mul(x.add(d))
		.div(AMM_RESERVE_PRECISION)
		.div(QUOTE_PRECISION);
	const denom2 = y
		.mul(d)
		.mul(d)
		.mul(Q)
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_RESERVE_PRECISION)
		.div(PEG_PRECISION);

	const numerator = d
		.mul(numer1.sub(numer2))
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_TO_QUOTE_PRECISION_RATIO);
	const denominator = denom1
		.add(denom2)
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_TO_QUOTE_PRECISION_RATIO);

	return [numerator, denominator];
}

require('dotenv').config();

const getSummary = async (
	clearingHouse: ClearingHouse,
) => {
	await clearingHouse.subscribe();

	let allQuoteAcq = 0;
	let allQuoteAcqLong = 0;
	let allQuoteAcqShort = 0;
	let allTotalFeeMinusDistributions = 0;
	let allTotalFee = 0;

	const result = [];

	const roundDecimal = (num, decimals = 3) => {
		return Math.round(num * 10 ** decimals) / 10 ** decimals;
	};

	const programUserPositionAccounts =
		await clearingHouse.program.account.userPositions.all();
	const programUserAccounts = await clearingHouse.program.account.user.all();

	const localUserPositionsPnl = Array(Markets.length).fill(0);
	const positionLongCostBasis = Array(Markets.length).fill(0);
	const positionShortCostBasis = Array(Markets.length).fill(0);

	const markets = clearingHouse.getMarketsAccount().markets;

	for (const positionsStr in programUserPositionAccounts) {
		const positions = programUserPositionAccounts[positionsStr].account.positions as UserPosition[];
		for (const positionStr in positions) {
			const position = positions[positionStr];
			if (position.baseAssetAmount.eq(ZERO)) {
				continue;
			}
			const posMarketIndex = position.marketIndex.toNumber();

			const posPnl = calculatePositionPNL(
				markets[posMarketIndex],
				position,
				true
			);
			const posPnlNum = convertToNumber(posPnl, QUOTE_PRECISION);

			localUserPositionsPnl[posMarketIndex] += posPnlNum;

			if (position.baseAssetAmount.gt(ZERO)) {
				positionLongCostBasis[posMarketIndex] += convertToNumber(
					position.quoteAssetAmount,
					QUOTE_PRECISION
				);
			} else {
				positionShortCostBasis[posMarketIndex] += convertToNumber(
					position.quoteAssetAmount,
					QUOTE_PRECISION
				);
			}
		}
	}

	let userRealiseCollateralLocal = 0;
	let localUserPnl = 0; // cur @ local
	let terminalUserPnl1 = 0; // net @ terminal
	let terminalUserPnl2 = 0; //  net @ terminal (two swap)

	for (const programUserAccount of programUserAccounts) {
		userRealiseCollateralLocal += convertToNumber(
			// @ts-ignore
			programUserAccount.account.collateral,
			QUOTE_PRECISION
		);

		// totalUserCollateralL = totalUserCollateral +
	}

	for (const market in markets) {
		const market0 = markets[market];
		const marketIndex = new BN(market).toNumber();
		if (!market0.initialized) {
			continue;
		}
		const market0M = clearingHouse.getMarket(marketIndex);

		const baseAssetNum = convertToNumber(
			market0.baseAssetAmount,
			AMM_RESERVE_PRECISION
		);
		const baseAssetLongNum = convertToNumber(
			market0.baseAssetAmountLong,
			AMM_RESERVE_PRECISION
		);
		const baseAssetShortNum = convertToNumber(
			market0.baseAssetAmountShort,
			AMM_RESERVE_PRECISION
		);

		const longQuoteAssetAmount = positionLongCostBasis[marketIndex];
		const shortQuoteAssetAmount = Math.abs(
			positionShortCostBasis[marketIndex]
		);
		let netQuoteAssetAmount;

		if (baseAssetNum > 0) {
			netQuoteAssetAmount = longQuoteAssetAmount - shortQuoteAssetAmount;
		} else {
			netQuoteAssetAmount = shortQuoteAssetAmount - longQuoteAssetAmount;
		}

		const netUserPosition = {
			baseAssetAmount: market0.baseAssetAmount,
			lastCumulativeFundingRate: market0.amm.cumulativeFundingRate,
			marketIndex: new BN(marketIndex),
			quoteAssetAmount: new BN(
				netQuoteAssetAmount * QUOTE_PRECISION.toNumber()
			),
			openOrders: ZERO,
		};
		const netUserLongPosition = {
			baseAssetAmount: market0.baseAssetAmountLong,
			lastCumulativeFundingRate: market0.amm.cumulativeFundingRate,
			marketIndex: new BN(marketIndex),
			quoteAssetAmount: new BN(
				longQuoteAssetAmount * QUOTE_PRECISION.toNumber()
			),
			openOrders: ZERO,
		};
		const netUserShortPosition = {
			baseAssetAmount: market0.baseAssetAmountShort,
			lastCumulativeFundingRate: market0.amm.cumulativeFundingRate,
			marketIndex: new BN(marketIndex),
			quoteAssetAmount: new BN(
				shortQuoteAssetAmount * QUOTE_PRECISION.toNumber()
			),
			openOrders: ZERO,
		};

		const reKCost = market0M.amm.totalFeeMinusDistributions;
		const [kNumer, kDenom] = calculateBudgetedK(market0M, reKCost);
		market0M.amm.totalFeeMinusDistributions =
			market0M.amm.totalFeeMinusDistributions.sub(reKCost);
		market0M.amm.sqrtK = market0M.amm.sqrtK.mul(kNumer).div(kDenom);
		market0M.amm.baseAssetReserve = market0M.amm.baseAssetReserve
			.mul(kNumer)
			.div(kDenom);

		market0M.amm.quoteAssetReserve = market0M.amm.quoteAssetReserve
			.mul(kNumer)
			.div(kDenom);

		// First way to calculate the terminal pnl
		const terminalUserPositionPnl = calculatePositionPNL(
			market0M,
			netUserPosition,
			false
		);

		const quoteAssetAcq = calculateBaseAssetValue(market0M, netUserPosition);
		const quoteAssetAcqNum = roundDecimal(
			convertToNumber(quoteAssetAcq, QUOTE_PRECISION)
		);
		allQuoteAcq += quoteAssetAcqNum;

		const quoteAssetAcqLong = calculateBaseAssetValue(
			market0M,
			netUserLongPosition
		);
		const quoteAssetAcqLongNum = roundDecimal(
			convertToNumber(quoteAssetAcqLong, QUOTE_PRECISION)
		);
		allQuoteAcqLong += quoteAssetAcqLongNum;

		const quoteAssetAcqShort = calculateBaseAssetValue(
			market0M,
			netUserShortPosition
		);
		const quoteAssetAcqShortNum = roundDecimal(
			convertToNumber(quoteAssetAcqShort, QUOTE_PRECISION)
		);
		allQuoteAcqShort += quoteAssetAcqShortNum;

		const exitPrice = quoteAssetAcq
			.mul(AMM_TO_QUOTE_PRECISION_RATIO)
			.mul(QUOTE_PRECISION)
			.div(market0.baseAssetAmount.abs());
		const directionToClose = netUserPosition.baseAssetAmount.gt(ZERO)
			? PositionDirection.SHORT
			: PositionDirection.LONG;

		const [newQuoteAssetReserve, newBaseAssetReserve] =
			calculateAmmReservesAfterSwap(
				market0M.amm,
				'base',
				netUserPosition.baseAssetAmount.abs(),
				getSwapDirection('base', directionToClose)
			);
		const terminalPrice = newQuoteAssetReserve
			.mul(MARK_PRICE_PRECISION)
			.mul(market0.amm.pegMultiplier)
			.div(PEG_PRECISION)
			.div(newBaseAssetReserve);

		const marketForLongs = Object.assign({}, market0);
		marketForLongs.amm = Object.assign({}, market0.amm);

		const marketForShorts = Object.assign({}, market0);
		marketForShorts.amm = Object.assign({}, market0.amm);

		const longPnl = calculatePositionPNL(
			marketForLongs,
			netUserLongPosition,
			false
		);
		const [quoteAsserReserveForShorts, baseAssetReserveForLongs] =
			calculateAmmReservesAfterSwap(
				marketForLongs.amm,
				'base',
				netUserLongPosition.baseAssetAmount.abs(),
				getSwapDirection('base', PositionDirection.SHORT)
			);

		marketForShorts.amm.baseAssetReserve = baseAssetReserveForLongs;
		marketForShorts.amm.quoteAssetReserve = quoteAsserReserveForShorts;
		const shortPnl = calculatePositionPNL(
			marketForShorts,
			netUserShortPosition,
			false
		);
		const terminalUserPositionPnl2 = convertToNumber(
			longPnl.add(shortPnl),
			QUOTE_PRECISION
		);

		const totalFee = convertToNumber(market0M.amm.totalFee, QUOTE_PRECISION);
		const totalFeeMinusDistributions = convertToNumber(
			market0M.amm.totalFeeMinusDistributions,
			QUOTE_PRECISION
		);
		allTotalFeeMinusDistributions += totalFeeMinusDistributions;
		allTotalFee += totalFee;

		// terminal pnl
		const terminalUserPositionPnlNum = convertToNumber(terminalUserPositionPnl, QUOTE_PRECISION);
		terminalUserPnl1 += terminalUserPositionPnlNum;

		terminalUserPnl2 += terminalUserPositionPnl2;

		// local pnl
		const localUserPositionPnl = localUserPositionsPnl[marketIndex];
		localUserPnl += localUserPositionPnl;

		const marketDesc = {
			marketSymbol: Markets[marketIndex].symbol,
			quoteAcq: roundDecimal(quoteAssetAcqNum),
			quoteAcqLong: roundDecimal(quoteAssetAcqLongNum),
			quoteAcqShort: roundDecimal(quoteAssetAcqShortNum),

			quotePaid: roundDecimal(netQuoteAssetAmount),
			quotePaidLong: roundDecimal(longQuoteAssetAmount),
			quotePaidShort: roundDecimal(shortQuoteAssetAmount),

			// terminal pnl
			terminalPnl1: roundDecimal(terminalUserPositionPnlNum),
			terminalPnl2: roundDecimal(terminalUserPositionPnl2),
			// local pnl
			localPnl: roundDecimal(localUserPositionPnl),
			pnlDivergence: roundDecimal(localUserPositionPnl - terminalUserPositionPnlNum),

			exitPrice: convertToNumber(exitPrice, QUOTE_PRECISION),
			terminalPrice: roundDecimal(
				convertToNumber(terminalPrice, MARK_PRICE_PRECISION)
			),
			peg: roundDecimal(
				convertToNumber(market0M.amm.pegMultiplier, PEG_PRECISION)
			),
			total_fee: roundDecimal(
				convertToNumber(market0M.amm.totalFee, QUOTE_PRECISION)
			),
			total_fee_minus_distributions: roundDecimal(
				convertToNumber(
					market0M.amm.totalFeeMinusDistributions,
					QUOTE_PRECISION
				)
			),

			baseAssetNet: baseAssetNum,
			baseAssetLong: baseAssetLongNum,
			baseAssetShort: baseAssetShortNum,

			entryPriceNet: roundDecimal(
				Math.abs(netQuoteAssetAmount / baseAssetNum)
			),
			entryPriceLong: roundDecimal(
				Math.abs(longQuoteAssetAmount / baseAssetLongNum)
			),
			entryPriceShort: roundDecimal(
				Math.abs(shortQuoteAssetAmount / baseAssetShortNum)
			),
		};

		result.push(marketDesc);
	}

	const insuranceVault = 99257.560977;
	const collateralVaultPlusInsuranceVaultBalance = 4937519.836505;
	const collateralVault = 4838262.27553;
	const userRealisedCollateralTerminal1 = userRealiseCollateralLocal + terminalUserPnl1;
	const totalUserCollateralLocal = userRealiseCollateralLocal + localUserPnl;
	const aggDesc = {
		marketSymbol: 'ALL',
		totalNetQuoteOI: allQuoteAcq,
		totalLongQuoteOI: allQuoteAcqLong,
		totalShortQuoteOI: allQuoteAcqShort,
		totalQuoteOI: allQuoteAcqLong + allQuoteAcqShort,
		collateralVault,
		insuranceVault,
		collateralVaultPlusInsuranceVaultBalance,
		userRealiseCollateralLocal,
		userRealisedCollateralTerminal1,
		userRealisedCollateralTerminal2: userRealiseCollateralLocal + terminalUserPnl2,
		totalUserCollateralLocal,
		leveredLoss:
			collateralVaultPlusInsuranceVaultBalance - (userRealiseCollateralLocal + terminalUserPnl1),
		realisedCollateralShortfall: userRealiseCollateralLocal - collateralVaultPlusInsuranceVaultBalance,
		totalPnlDivergence: totalUserCollateralLocal - userRealisedCollateralTerminal1,
	};

	result.push(aggDesc);
	await clearingHouse.unsubscribe();

	return result;
};

//@ts-ignore
const sdkConfig = initialize({ env: process.env.ENV });
const endpoint = process.env.ENDPOINT;
const connection = new Connection(endpoint);

(async () => {
	const clearingHousePublicKey = new PublicKey(
		sdkConfig.CLEARING_HOUSE_PROGRAM_ID
	);

	const clearingHouse = ClearingHouse.from(
		connection,
		new Wallet(new Keypair()),
		clearingHousePublicKey
	);


	const res = await getSummary(clearingHouse);
	console.log(res);
	const fs = require('fs');
	const today = new Date();
	const date =
		today.getFullYear() +
		'-' +
		(today.getMonth() + 1) +
		'-' +
		today.getDate();
	const time =
		today.getHours() + '-' + today.getMinutes() + '-' + today.getSeconds();
	const dateTime = date + '_' + time;
	fs.writeFile(
		'dammDesc' + dateTime + '.json',
		JSON.stringify(res),
		function (err) {
			if (err) throw err;
			console.log('complete');
		}
	);
})();
