import { Connection, PublicKey } from "@solana/web3.js";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const MIN_TOKEN_ACCOUNT_DATA_LEN = 64;

// 1) Build a (tokenAccount -> realOwner) map from instructions like initializeAccount3, createAccount, etc.
function buildTokenAccountMapFromInstructions(parsedTx) {
  const map = {};
  function handleIx(ix) {
    if (!ix?.parsed?.info) return;
    const { type, info } = ix.parsed;
    if (!type || !info) return;

    if (type.startsWith("initializeAccount") && info.account && info.owner) {
      map[info.account] = info.owner;
    } else if (
      type.startsWith("create") &&
      (info.account || info.newAccount) &&
      (info.owner || info.wallet)
    ) {
      const tokenAcc = info.account || info.newAccount;
      map[tokenAcc] = info.owner || info.wallet;
    }
  }

  for (const ix of parsedTx.transaction.message.instructions || []) {
    handleIx(ix);
  }
  for (const group of parsedTx.meta.innerInstructions || []) {
    for (const ix of group.instructions) {
      handleIx(ix);
    }
  }

  return map;
}

// 2) Build a map from meta pre/post token balances => (tokenAccount -> { mint, decimals, owner })
function buildTokenAccountMapFromBalances(parsedTx) {
  const map = {};
  const keys = parsedTx.transaction.message.accountKeys || [];

  function gather(balArr = []) {
    for (const b of balArr) {
      if (b?.accountIndex == null) continue;
      const acctObj = keys[b.accountIndex];
      const acct = typeof acctObj === "string" ? acctObj : acctObj?.pubkey;
      if (!acct) continue;

      if (!map[acct]) map[acct] = {};
      if (b.mint) map[acct].mint = b.mint;
      if (b.owner) map[acct].owner = b.owner;
      const dec = b.uiTokenAmount?.decimals;
      if (dec != null) map[acct].decimals = dec;
    }
  }

  gather(parsedTx.meta.preTokenBalances);
  gather(parsedTx.meta.postTokenBalances);
  return map;
}

// 4) Parse instructions for SPL token / SOL transfers
function parseInstructionTransfers(ix, includeSolTransfers = true) {
  const out = [];
  if (!ix?.parsed?.info) return out;
  const { type, info } = ix.parsed;
  if (!type || !info) return out;

  // SPL token instructions
  if (
    type === "transfer" ||
    type === "transferChecked" ||
    type === "transferCheckedWithFee"
  ) {
    const rawFrom = info.source || info.authority;
    const rawTo = info.destination;
    let amt =
      info.amount || (info.tokenAmount && info.tokenAmount.amount) || "0";
    let mt = info.mint || "UNKNOWN_MINT";
    let dec = (info.tokenAmount && info.tokenAmount.decimals) || 0;
    out.push({
      from: rawFrom,
      to: rawTo,
      mint: mt,
      amount: String(amt),
      decimals: dec,
      rawFrom,
      rawTo,
    });
  }

  // SOL transfers
  if (includeSolTransfers && type === "transfer" && info.lamports) {
    out.push({
      from: info.source,
      to: info.destination,
      mint: "SOL",
      amount: String(info.lamports),
      decimals: 9,
      rawFrom: info.source,
      rawTo: info.destination,
    });
  }

  // createAccount => SOL
  if (includeSolTransfers && type === "createAccount" && info.lamports) {
    out.push({
      from: info.source,
      to: info.newAccount,
      mint: "SOL",
      amount: String(info.lamports),
      decimals: 9,
      rawFrom: info.source,
      rawTo: info.newAccount,
    });
  }

  return out;
}

/**
 * Fetch info for multiple token accounts via getMultipleAccountsInfo.
 * We parse the data if it's a valid SPL token account (owner == TOKEN_PROGRAM_ID, length >= 64).
 * Then we store { owner, mint, decimals? } in an in-memory cache.
 */
async function fetchMultipleTokenAccountInfos(
  conn,
  tokenAccounts,
  onChainCache
) {
  // Convert strings to PublicKey
  const pubkeys = tokenAccounts.map((a) => new PublicKey(a));

  // Single RPC call
  const accountInfos = await conn.getMultipleAccountsInfo(pubkeys);

  // Parse each returned info
  for (let i = 0; i < accountInfos.length; i++) {
    const addr = tokenAccounts[i];
    const info = accountInfos[i];

    // If not found, or not owned by the token program, skip
    if (!info || !info.owner.equals(TOKEN_PROGRAM_ID)) {
      onChainCache[addr] = { owner: null, mint: null };
      continue;
    }

    // If not enough data, skip
    if (info.data.length < MIN_TOKEN_ACCOUNT_DATA_LEN) {
      onChainCache[addr] = { owner: null, mint: null };
      continue;
    }

    // Parse out the mint & owner from the 64 bytes
    const buffer = info.data;
    const mintPubKey = new PublicKey(buffer.subarray(0, 32));
    const ownerPubKey = new PublicKey(buffer.subarray(32, 64));

    onChainCache[addr] = {
      owner: ownerPubKey.toBase58(),
      mint: mintPubKey.toBase58(),
    };
  }
}

export async function parseTransfersFromSignature(
  signature,
  includeSolTransfers = true
) {
  const HELIUS_API_KEY = "API-KEY"; // Replace with API key
  const BASE_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
  const conn = new Connection(BASE_URL, "confirmed");

  const parsedTx = await conn.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });

  if (!parsedTx || !parsedTx.meta) return [];

  // A) Gather raw transfers from instructions
  const transfers = [];
  for (const ix of parsedTx.transaction.message.instructions || []) {
    transfers.push(...parseInstructionTransfers(ix, includeSolTransfers));
  }
  for (const grp of parsedTx.meta.innerInstructions || []) {
    for (const ix of grp.instructions) {
      transfers.push(...parseInstructionTransfers(ix, includeSolTransfers));
    }
  }

  // B) Build partial maps
  const ixMap = buildTokenAccountMapFromInstructions(parsedTx); // (acct -> owner)
  const balMap = buildTokenAccountMapFromBalances(parsedTx); // (acct -> { mint, decimals, owner })

  // unify => tokenAccountData[acct] = { mint, decimals, owner }
  const tokenAccountData = {};
  for (const acct in balMap) {
    tokenAccountData[acct] = { ...balMap[acct] };
  }
  for (const acct in ixMap) {
    if (!tokenAccountData[acct]) tokenAccountData[acct] = {};
    tokenAccountData[acct].owner = ixMap[acct];
  }

  // Keep an in-memory cache so we don't re-fetch the same accounts multiple times in other calls
  const onChainCache = {};

  // Gather leftover addresses that we STILL need owners/mints for.
  const addressesToFetch = new Set();
  for (const t of transfers) {
    // Check from/to ephemeral token accounts
    [t.rawFrom, t.rawTo].forEach((addr) => {
      // If no data or partial data, we likely want to fetch on-chain
      const existing = tokenAccountData[addr];
      if (!existing || !existing.owner || existing.mint === "UNKNOWN_MINT") {
        addressesToFetch.add(addr);
      }
    });
  }

  // Single batch fetch for all unknown addresses
  if (addressesToFetch.size > 0) {
    await fetchMultipleTokenAccountInfos(
      conn,
      [...addressesToFetch],
      onChainCache
    );
  }

  // incorporate onChainCache results into tokenAccountData
  for (const addr of addressesToFetch) {
    if (!tokenAccountData[addr]) {
      tokenAccountData[addr] = {};
    }
    const cached = onChainCache[addr];
    // If we got data back:
    if (cached && cached.owner) {
      tokenAccountData[addr].owner = cached.owner;
    }
    if (cached && cached.mint) {
      tokenAccountData[addr].mint = cached.mint;
    }
  }

  // Rewrite ephemeral token accounts => real owners
  for (const t of transfers) {
    const fData = tokenAccountData[t.rawFrom];
    const toData = tokenAccountData[t.rawTo];
    if (fData && fData.owner) t.from = fData.owner;
    if (toData && toData.owner) t.to = toData.owner;
  }

  // Fix "UNKNOWN_MINT" or decimals=0 by checking tokenAccountData
  for (const t of transfers) {
    const fData = tokenAccountData[t.rawFrom] || {};
    const toData = tokenAccountData[t.rawTo] || {};

    // If the instruction says "UNKNOWN_MINT", attempt to pick from our data
    if (t.mint === "UNKNOWN_MINT") {
      if (fData.mint) {
        t.mint = fData.mint;
        if (fData.decimals != null) {
          t.decimals = fData.decimals;
        }
      } else if (toData.mint) {
        t.mint = toData.mint;
        if (toData.decimals != null) {
          t.decimals = toData.decimals;
        }
      }
    }

    // If decimals are 0 but we do have a real decimal in fData or toData
    if (t.decimals === 0) {
      if (fData.decimals != null && fData.decimals > 0) {
        t.decimals = fData.decimals;
      } else if (toData.decimals != null && toData.decimals > 0) {
        t.decimals = toData.decimals;
      }
    }
  }

  // Return final, with an additional uiAmount
  return transfers.map((x) => {
    let uiAmount = null;
    try {
      const rawNum = parseFloat(x.amount);
      if (!isNaN(rawNum)) {
        uiAmount = rawNum / Math.pow(10, x.decimals || 0);
      }
    } catch (err) {
      // keep uiAmount as null
    }
    return {
      fromTokenAccount: x.rawFrom,
      toTokenAccount: x.rawTo,
      fromUserAccount: x.from,
      toUserAccount: x.to,
      amount: x.amount,
      mint: x.mint,
      decimals: x.decimals,
      uiAmount,
    };
  });
}

(async () => {
  const sig =
    "TRANSACTION_SIGNATURE";

  const startTime = Date.now();
  const results = await parseTransfersFromSignature(sig);
  const endTime = Date.now();

  console.log("Transfers found:", results);
  console.log(`Total time in example usage: ${endTime - startTime} ms`);
})();
