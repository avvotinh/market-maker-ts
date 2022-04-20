import {
    Account,
    Commitment,
    Connection, PublicKey,
    Transaction,
    TransactionInstruction,
} from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import { BN } from 'bn.js';
import {
    BookSide,
    BookSideLayout,
    Cluster,
    Config,
    getMultipleAccounts,
    getPerpMarketByBaseSymbol,
    GroupConfig,
    IDS,
    MangoAccount,
    MangoAccountLayout,
    MangoCache,
    MangoCacheLayout,
    MangoClient,
    MangoGroup,
    PerpMarket,
    PerpMarketConfig,
    sleep,
    zeroKey,
} from '@blockworks-foundation/mango-client';
import { OpenOrders } from '@project-serum/serum';
import path from 'path';
import {
    loadMangoAccountWithName,
    loadMangoAccountWithPubkey
} from './utils';

const paramsFileName = process.env.PARAMS || 'default.json';
const params = JSON.parse(
    fs.readFileSync(
        path.resolve(__dirname, `../params/${paramsFileName}`),
        'utf-8',
    ),
);

const payer = new Account(
    JSON.parse(
        fs.readFileSync(
            process.env.KEYPAIR || os.homedir() + '/.config/solana/id.json',
            'utf-8',
        ),
    ),
);

const config = new Config(IDS);

const groupIds = config.getGroupWithName(params.group) as GroupConfig;
if (!groupIds) {
    throw new Error(`Group ${params.group} not found`);
}
const cluster = groupIds.cluster as Cluster;
const mangoProgramId = groupIds.mangoProgramId;
const mangoGroupKey = groupIds.publicKey;

const control = { isRunning: true, interval: params.interval };

type MarketContext = {
    marketName: string;
    params: any;
    config: PerpMarketConfig;
    market: PerpMarket;
    marketIndex: number;
    bids: BookSide;
    asks: BookSide;
};
/**
 * Load MangoCache, MangoAccount and Bids and Asks for all PerpMarkets using only
 * one RPC call.
 */
async function loadAccountAndMarketState(
    connection: Connection,
    group: MangoGroup,
    oldMangoAccount: MangoAccount,
    marketContexts: MarketContext[],
): Promise<{
    cache: MangoCache;
    mangoAccount: MangoAccount;
    marketContexts: MarketContext[];
}> {
    const inBasketOpenOrders = oldMangoAccount
        .getOpenOrdersKeysInBasket()
        .filter((pk) => !pk.equals(zeroKey));

    const allAccounts = [
        group.mangoCache,
        oldMangoAccount.publicKey,
        ...inBasketOpenOrders,
        ...marketContexts.map((marketContext) => marketContext.market.bids),
        ...marketContexts.map((marketContext) => marketContext.market.asks),
    ];

    const accountInfos = await getMultipleAccounts(connection, allAccounts);

    const cache = new MangoCache(
        accountInfos[0].publicKey,
        MangoCacheLayout.decode(accountInfos[0].accountInfo.data),
    );

    const mangoAccount = new MangoAccount(
        accountInfos[1].publicKey,
        MangoAccountLayout.decode(accountInfos[1].accountInfo.data),
    );
    const openOrdersAis = accountInfos.slice(2, 2 + inBasketOpenOrders.length);
    for (let i = 0; i < openOrdersAis.length; i++) {
        const ai = openOrdersAis[i];
        const marketIndex = mangoAccount.spotOpenOrders.findIndex((soo) =>
            soo.equals(ai.publicKey),
        );
        mangoAccount.spotOpenOrdersAccounts[marketIndex] =
            OpenOrders.fromAccountInfo(
                ai.publicKey,
                ai.accountInfo,
                group.dexProgramId,
            );
    }

    accountInfos
        .slice(
            2 + inBasketOpenOrders.length,
            2 + inBasketOpenOrders.length + marketContexts.length,
        )
        .forEach((ai, i) => {
            marketContexts[i].bids = new BookSide(
                ai.publicKey,
                marketContexts[i].market,
                BookSideLayout.decode(ai.accountInfo.data),
            );
        });

    accountInfos
        .slice(
            2 + inBasketOpenOrders.length + marketContexts.length,
            2 + inBasketOpenOrders.length + 2 * marketContexts.length,
        )
        .forEach((ai, i) => {
            marketContexts[i].asks = new BookSide(
                ai.publicKey,
                marketContexts[i].market,
                BookSideLayout.decode(ai.accountInfo.data),
            );
        });

    return {
        cache,
        mangoAccount,
        marketContexts,
    };
}
async function fullCheckOwner() {
    const connection = new Connection(
        process.env.ENDPOINT_URL || config.cluster_urls[cluster],
        'processed' as Commitment,
    );
    const client = new MangoClient(connection, mangoProgramId);

    // load group
    const mangoGroup = await client.getMangoGroup(mangoGroupKey);

    // load mangoAccount
    let mangoAccount: MangoAccount;
    if (params.mangoAccountName) {
        mangoAccount = await loadMangoAccountWithName(
            client,
            mangoGroup,
            payer,
            params.mangoAccountName,
        );
    } else if (params.mangoAccountPubkey) {
        mangoAccount = await loadMangoAccountWithPubkey(
            client,
            mangoGroup,
            payer,
            new PublicKey(params.mangoAccountPubkey),
        );
    } else {
        throw new Error(
            'Please add mangoAccountName or mangoAccountPubkey to params file',
        );
    }

    const marketContexts: MarketContext[] = [];
    for (const baseSymbol in params.assets) {
        const perpMarketConfig = getPerpMarketByBaseSymbol(
            groupIds,
            baseSymbol,
        ) as PerpMarketConfig;
        const perpMarket = await client.getPerpMarket(
            perpMarketConfig.publicKey,
            perpMarketConfig.baseDecimals,
            perpMarketConfig.quoteDecimals,
        );
        marketContexts.push({
            marketName: perpMarketConfig.name,
            params: params.assets[baseSymbol].perp,
            config: perpMarketConfig,
            market: perpMarket,
            marketIndex: perpMarketConfig.marketIndex,
            bids: await perpMarket.loadBids(connection),
            asks: await perpMarket.loadAsks(connection),
        });
    }

    process.on('SIGINT', function () {
        console.log('Caught keyboard interrupt. End');
        control.isRunning = false;
        onExit();
    });

    // Create your bot and tell it about your context type
    while (control.isRunning) {

        try {
            const state = await loadAccountAndMarketState(
                connection,
                mangoGroup,
                mangoAccount,
                marketContexts,
            );
            mangoAccount = state.mangoAccount;

            // console.log(`Current Average TPS: ${averageTPS.toLocaleString()}`);
            let message: string = "";
            for (let i = 0; i < marketContexts.length; i++) {
                if (marketContexts[i].params.isCheck) {
                    const marketMessage = checkOwner(
                        mangoGroup,
                        state.cache,
                        mangoAccount,
                        marketContexts[i],
                        message
                    );
                    if (marketMessage !== "") {
                        message += "\n" + marketMessage;
                    }
                }
            }
        } catch (e) {
            console.log(e);
        } finally {
            let timeSleep = control.interval;
            // console.log(
            // `${new Date().toUTCString()} sleeping for ${timeSleep / 1000}s`,
            // );
            // console.log(`---END---`);
            await sleep(timeSleep);
        }
    }
}

function checkOwner(
    group: MangoGroup,
    cache: MangoCache,
    mangoAccount: MangoAccount,
    marketContext: MarketContext,
    message: string,
): string {
    let marketMessage: string = "";
    // Right now only uses the perp
    const marketIndex = marketContext.marketIndex;
    const market = marketContext.market;
    // const priceLotsToUiConvertor = market.priceLotsToUiConvertor;
    // console.log(priceLotsToUiConvertor);
    const bids = marketContext.bids;
    let bidCount = 0;
    for (const bid of bids) {
        bidCount++;
        if (bidCount > 50) {
            break;
        }
        if (bid.size > 1.2) {
            console.log(`owner: ${bid.owner} - size: ${bid.size} - price: ${bid.price}`);
        }
    }

    // const asks = marketContext.asks;
    // let askCount = 0;
    // for (const ask of asks) {
    //     askCount++;
    //     if (askCount > 50) {
    //         break;
    //     }
    //     if (ask.size > 692) {
    //         console.log(`owner: ${ask.owner} - size: ${ask.size} - price: ${ask.price}`);
    //     }
    // }

    return marketMessage;
}

function startCheckOwner() {
    if (control.isRunning) {
        fullCheckOwner().finally(startCheckOwner);
    }
}

async function onExit() {
    console.log('Exiting ...');
    process.exit();
}

process.on('unhandledRejection', function (err, promise) {
    console.error(
        'Unhandled rejection (promise: ',
        promise,
        ', reason: ',
        err,
        ').',
    );
});

startCheckOwner();