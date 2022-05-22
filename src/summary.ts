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

function calculateBudgetedK(market: Market, cost: BN): [BN, BN] {
	// wolframalpha.com
	// (1/(x+d) - p/(x*p+d))*y*d*Q = C solve for p
	// p = (d(y*d*Q - C(x+d))) / (C*x(x+d) + y*y*d*Q)

	// todo: assumes k = x * y
	// otherwise use: (y(1-p) + (kp^2/(x*p+d)) - k/(x+d)) * Q = C solve for p

	// const k = market.amm.sqrtK.mul(market.amm.sqrtK);
	const x = market.amm.baseAssetReserve;
	const y = market.amm.quoteAssetReserve;

	const d = market.baseAssetAmount;
	const Q = market.amm.pegMultiplier;

	const C = cost.mul(new BN(-1));

	console.log(
		convertToNumber(x, AMM_RESERVE_PRECISION),
		convertToNumber(y, AMM_RESERVE_PRECISION),
		convertToNumber(d, AMM_RESERVE_PRECISION),
		Q.toNumber() / 1e3,
		C.toNumber() / 1e6
	);

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

	// console.log('numers:', convertToNumber(numer1), convertToNumber(numer2));
	// console.log('denoms:', convertToNumber(denom1), convertToNumber(denom2));

	const numerator = d
		.mul(numer1.sub(numer2))
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_TO_QUOTE_PRECISION_RATIO);
	const denominator = denom1
		.add(denom2)
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_TO_QUOTE_PRECISION_RATIO);
	console.log(numerator, denominator);
	// const p = (numerator).div(denominator);

	// const formulaCost = numer21
	// 	.sub(numer20)
	// 	.sub(numer1)
	// 	.mul(market.amm.pegMultiplier)
	// 	.div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO);
	// console.log(convertToNumber(formulaCost, QUOTE_PRECISION));

	return [numerator, denominator];
}

require('dotenv').config();

const getSummary = async (
	clearingHouse: ClearingHouse,
) => {
	await clearingHouse.subscribe();

	// await updateUserAccounts();
	let allQuoteAcq = 0;
	let allQuoteAcqLong = 0;
	let allQuoteAcqShort = 0;
	let alltFMD = 0;
	let alltF = 0;

	const result = [];

	const roundDecimal = (num, decimals = 3) => {
		return Math.round(num * 10 ** decimals) / 10 ** decimals;
	};

	const programUserPositionAccounts =
		await clearingHouse.program.account.userPositions.all();
	const programUserAccounts = await clearingHouse.program.account.user.all();

	console.log(programUserPositionAccounts.length, 'user positions');

	const positionPnL = Array(Markets.length).fill(0);
	const positionLongCostBasis = Array(Markets.length).fill(0);
	const positionShortCostBasis = Array(Markets.length).fill(0);

	const markets = clearingHouse.getMarketsAccount().markets;

	for (const positionsStr in programUserPositionAccounts) {
		const positions1 = programUserPositionAccounts[positionsStr];
		const positions = positions1.account.positions as UserPosition[];
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
			// console.log(posPnlNum)

			positionPnL[posMarketIndex] += posPnlNum;

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

			// const userPositionDesc = {
			// 	posPnl: posPnlNum,
			// 	marketIndex: posMarketIndex,
			// 	authority: positions1.account.authority,
			// };
		}

		// userPosResult.push(userPositionDesc);
	}

	console.log(programUserAccounts.length, 'users');

	let totalUserCollateral = 0;
	// let totalUserCollateralL = 0;
	let totalPnl1 = 0; // net @ terminal
	let totalPnl2 = 0; // cur @ local
	let totalPnl2Swap = 0; //  net @ terminal (two swap)

	for (const programUserAccount of programUserAccounts) {
		totalUserCollateral += convertToNumber(
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
		console.log(Markets[marketIndex].symbol);

		// const netMarketBaseAssetAmountNum = convertToNumber(
		// 	market0.baseAssetAmount,
		// 	AMM_RESERVE_PRECISION
		// );
		// const totalOINum = convertToNumber(
		// 	market0.baseAssetAmountLong.sub(market0.baseAssetAmountShort),
		// 	AMM_RESERVE_PRECISION
		// );

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
		// netQuoteAssetAmount = Math.abs((longQuoteAssetAmount+shortQuoteAssetAmount)*(netMarketBaseAssetAmountNum/totalOINum));

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
			// quoteAssetAmount: new BN(0),
		};
		const netUserLongPosition = {
			baseAssetAmount: market0.baseAssetAmountLong,
			lastCumulativeFundingRate: market0.amm.cumulativeFundingRate,
			marketIndex: new BN(marketIndex),
			quoteAssetAmount: new BN(
				longQuoteAssetAmount * QUOTE_PRECISION.toNumber()
			),
			openOrders: ZERO,
			// quoteAssetAmount: new BN(0),
		};
		const netUserShortPosition = {
			baseAssetAmount: market0.baseAssetAmountShort,
			lastCumulativeFundingRate: market0.amm.cumulativeFundingRate,
			marketIndex: new BN(marketIndex),
			quoteAssetAmount: new BN(
				shortQuoteAssetAmount * QUOTE_PRECISION.toNumber()
			),
			openOrders: ZERO,
			// quoteAssetAmount: new BN(0),
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

		const quoteAssetPnL = calculatePositionPNL(
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
		const terminalPrice2 = newQuoteAssetReserve
			.mul(MARK_PRICE_PRECISION)
			.mul(market0.amm.pegMultiplier)
			.div(PEG_PRECISION)
			.div(newBaseAssetReserve);

		const marketForLongs = Object.assign({}, market0);
		marketForLongs.amm = Object.assign({}, market0.amm);

		const marketForShorts = Object.assign({}, market0);
		marketForShorts.amm = Object.assign({}, market0.amm);

		// console.log('current price:', roundDecimal(convertToNumber(calculateMarkPrice(market0M))));
		// console.log('long value:', convertToNumber(calculateBaseAssetValue(market0M, netUserLongPosition),  QUOTE_PRECISION));

		// const [newQuoteAssetReserveLongClosed1, newBaseAssetReserveLongClosed1] = calculateAmmReservesAfterSwap(
		//     market0M.amm,
		//     'base',
		//     netUserLongPosition.baseAssetAmount.abs(),
		//     getSwapDirection('base', PositionDirection.SHORT)
		// );

		// marketForShorts.amm.baseAssetReserve = newBaseAssetReserveLongClosed1;
		// marketForShorts.amm.quoteAssetReserve = newQuoteAssetReserveLongClosed1;
		// const terminalPriceLongClosed1 = newQuoteAssetReserveLongClosed1
		// .mul(MARK_PRICE_PRECISION)
		// .mul(market0.amm.pegMultiplier)
		// .div(PEG_PRECISION)
		// .div(newBaseAssetReserveLongClosed1);

		// console.log('long closed price:', roundDecimal(convertToNumber(terminalPriceLongClosed1)));

		// console.log('short value:', convertToNumber(calculateBaseAssetValue(market0M, netUserShortPosition), QUOTE_PRECISION));

		// const [newQuoteAssetReserveShortClosed2, newBaseAssetReserveShortClosed2] = calculateAmmReservesAfterSwap(
		//     marketForShorts.amm,
		//     'base',
		//     netUserShortPosition.baseAssetAmount.abs(),
		//     getSwapDirection('base', PositionDirection.LONG)
		// );
		// const terminalPriceShortClosed2 = newQuoteAssetReserveShortClosed2
		// .mul(MARK_PRICE_PRECISION)
		// .mul(market0.amm.pegMultiplier)
		// .div(PEG_PRECISION)
		// .div(newBaseAssetReserveShortClosed2);

		// console.log('short closed price:', roundDecimal(convertToNumber(terminalPriceShortClosed2)));

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
		const quoteAssetPnL2Swap = convertToNumber(
			longPnl.add(shortPnl),
			QUOTE_PRECISION
		);

		const tF = convertToNumber(market0M.amm.totalFee, QUOTE_PRECISION);
		const tFMD = convertToNumber(
			market0M.amm.totalFeeMinusDistributions,
			QUOTE_PRECISION
		);
		alltFMD += tFMD;
		alltF += tF;

		// terminal pnl
		const pnl1 = convertToNumber(quoteAssetPnL, QUOTE_PRECISION);
		totalPnl1 += pnl1;

		totalPnl2Swap += quoteAssetPnL2Swap;

		// local pnl
		const pnl2 = positionPnL[marketIndex];
		totalPnl2 += pnl2;

		const marketDesc = {
			marketSymbol: Markets[marketIndex].symbol,
			quoteAcq: roundDecimal(quoteAssetAcqNum),
			quoteAcqLong: roundDecimal(quoteAssetAcqLongNum),
			quoteAcqShort: roundDecimal(quoteAssetAcqShortNum),

			quotePaid: roundDecimal(netQuoteAssetAmount),
			quotePaidLong: roundDecimal(longQuoteAssetAmount),
			quotePaidShort: roundDecimal(shortQuoteAssetAmount),

			// terminal pnl
			quotePnL: roundDecimal(pnl1),
			// local pnl
			quotePnL2: roundDecimal(pnl2),
			quotePnL2Swap: roundDecimal(quoteAssetPnL2Swap),

			exitPrice: convertToNumber(exitPrice, QUOTE_PRECISION),
			terminalPrice: roundDecimal(
				convertToNumber(terminalPrice2, MARK_PRICE_PRECISION)
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

	const collateralVaultPlusInsuranceVaultBalance = 4937519.836505;
	const aggDesc = {
		marketSymbol: 'ALL',
		totalNetQuoteOI: allQuoteAcq,
		totalLongQuoteOI: allQuoteAcqLong,
		totalShortQuoteOI: allQuoteAcqShort,
		totalQuoteOI: allQuoteAcqLong + allQuoteAcqShort,
		collateralVaultPlusInsuranceVaultBalance,
		totalUserCollateral: totalUserCollateral,
		totalUserCollateralTerminal: totalUserCollateral + totalPnl1,
		totalUserCollateralTerminal2: totalUserCollateral + totalPnl2Swap,
		totalUserCollateralLocal: totalUserCollateral + totalPnl2,
		allTotalFee: alltF,
		allTotalFeeMinusDistributions: alltFMD,
		systemSurplus:
			collateralVaultPlusInsuranceVaultBalance - (totalUserCollateral + totalPnl1 + alltFMD),
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
