// app/api/import-csv-wallets/route.ts
// One-time import to update wallet addresses from CSV data

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// CSV data with wallet mappings (from whale_watchlist.csv)
const CSV_WALLET_MAPPINGS: Record<string, string> = {
  "0xc2e7800b5af46e6093872b177b7a5e7f0563be51": "0xc2e7800b5af46e6093872b177b7a5e7f0563be51",
  "beachboy4": "0xc2e7800b5af46e6093872b177b7a5e7f0563be51",
  "0xb7511d7b0dcb75ffad0507cbac7223653d08915": "0xb7511d7b0dcb75ffad0507cbac7223653d08915",
  "0x2c335066FE58fe9237c3d3Dc7b275C2a034a0563": "0x2c335066FE58fe9237c3d3Dc7b275C2a034a0563",
  "kch123": "0x6a72f61820b26b1fe4d956e17b6dc2a1ea3033ee",
  "0xabB89972B21B304C1bEd2Bf26F35c8741aC9bBA3": "0xabB89972B21B304C1bEd2Bf26F35c8741aC9bBA3",
  "SeriouslySirius": "0x16b29c50f2439faf627209b2ac0c7bbddaa8a881",
  "0xe74A4446EfD66A4de690962938F550D8921A40Ee": "0xe74A4446EfD66A4de690962938F550D8921A40Ee",
  "0xF0bC46E69C9c68703FF0a2c0083E61d484E6Af98": "0xF0bC46E69C9c68703FF0a2c0083E61d484E6Af98",
  "gmanas": "0xe90bec87d9ef430f27f9dcfe72c34b76967d5da2",
  "0x006cc834Cc092684F1B56626E23BEdB3835c16ea": "0x006cc834Cc092684F1B56626E23BEdB3835c16ea",
  "statwC00KS": "0x57a8d63731277200ed26cfde9a8a830d94f36933",
  "elkmonkey": "0xead152b855effa6b5b5837f53b24c0756830c76a",
  "0x8cbb318B8863898f0907deE7113453EB75FaACB2": "0x8cbb318B8863898f0907deE7113453EB75FaACB2",
  "knedloveprovelo": "0xd6a3f0ec6c4a8ad680d580610c82ca57ff139489",
  "0x062740fdec4d624eb01Df83E3b23D468c37fDADA": "0x062740fdec4d624eb01Df83E3b23D468c37fDADA",
  "0x8929a0cE1c13aE9C9643F94A3F7E67580Fad0196": "0x8929a0cE1c13aE9C9643F94A3F7E67580Fad0196",
  "sleepy-panda": "0xa49becb692927d455924583b5e3e5788246f4c40",
  "gamblingdebt": "0xc8b438e4a1c10643ea0ea3e59bcaadc73174f05d",
  "sovereign2013": "0xee613b3fc183ee44f9da9c05f53e2da107e3debf",
  "swisstony": "0x204f72f35326db932158cba6adff0b9a1da95e14",
  "richfeynman": "0x481b018cfd404a20e61eeb6805afbc413c1a74c1",
  "0xe287a1E8925e46CaFD2392EF044cC789083bfB29": "0xe287a1E8925e46CaFD2392EF044cC789083bfB29",
  "moje999": "0x18d12d50db693ea3258edaa721c8ffa6eb7bdbcb",
  "0x3a613cdb8f00f7afe0196cbbb91bdb597383b560": "0x3a613cdb8f00f7afe0196cbbb91bdb597383b560",
  "0x8bc3adbbfafbeaf13aeeb0ca8847c8e9": "0x8bc3adbbfafbeaf13aeeb0ca8847c8e9",
  "gopatriots": "0xe20a1538293903b746ffe6c4ce2d5c3c0300e469",
  "0x24357454d8d1a0cc93a6c25fd490467372bc2454": "0x24357454d8d1a0cc93a6c25fd490467372bc2454",
  "0xe62d0223966f7cee8cc77065150a2db417bcc34": "0xe62d0223966f7cee8cc77065150a2db417bcc34",
  "SMCAOMCRL": "0x3b5c629f114098b0dee345fb78b7a3a013c7126e",
  "EIf": "0xd6966eb1ae7b52320ba7ab1016680198c9e08a49",
  "EF203F2IPFC2ICP20W-CP3": "0x4133bcbad1d9c41de776646696f41c34d0a65e70",
  "dfsgretfewqrfew": "0xfefb4ab20c207f11278c222e5276546727f74b5d",
  "0x6f2628a8ac6e3f7bd857657d5316c33822ced13": "0x6f2628a8ac6e3f7bd857657d5316c33822ced13",
  "PurpleThunderBicycleMountain": "0x589222a5124a96765443b97a3498d89ffd824ad2",
  "0xb2A922": "0xb2A922",
  "0xB0C9E2355F4E2F6BFC86E9712EdE129e07ac53dE": "0xB0C9E2355F4E2F6BFC86E9712EdE129e07ac53dE",
  "amused85": "0x8fe70c889ce14f67acea5d597e3d0351d73b4f20",
  "0x9C6A6E0b25b08B19c36C7fC878B3c216a359B584": "0x9C6A6E0b25b08B19c36C7fC878B3c216a359B584",
  "0x29f99b23d58F02301b661D3bAc302B5B7487E310": "0x29f99b23d58F02301b661D3bAc302B5B7487E310",
  "0xead02f1568144be782d762e2b6a719302830f3ba": "0xead02f1568144be782d762e2b6a719302830f3ba",
  "0x9de7BEFB12b46F6F72249E2479809c8cE8FE70d6": "0x9de7BEFB12b46F6F72249E2479809c8cE8FE70d6",
  "DollarScholar": "0x4c814578c17f53118b312165873059a463a0fce3",
  "0x13A0b8FF7bae4E8ED881Bd2a63ec94f97E5828a5": "0x13A0b8FF7bae4E8ED881Bd2a63ec94f97E5828a5",
  "RN1": "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
  "0xdE22e428B62769BF73BAfabf2D0fd8cDbE92555E": "0xdE22e428B62769BF73BAfabf2D0fd8cDbE92555E",
  "0x9615A81A49Fa2F1F234aE138EAC87e3828a260dd": "0x9615A81A49Fa2F1F234aE138EAC87e3828a260dd",
  "kingofcoinflips": "0xe9c6312464b52aa3eff13d822b003282075995c9",
  "0x23dAbaF01BDDA09778Ec4DFf543853fc28FD41D9": "0x23dAbaF01BDDA09778Ec4DFf543853fc28FD41D9",
  "0xC94A2031b8b4Cc4cF77eac0FD0e0B982b7b29401": "0xC94A2031b8b4Cc4cF77eac0FD0e0B982b7b29401",
  "ExpressoMartini": "0x080a53ccb5caf5949d2e67074e8629fe1f249da4",
  "0x96E17Ba97E081732a552F410eb35eE972Cad50aa": "0x96E17Ba97E081732a552F410eb35eE972Cad50aa",
  "0x057": "0x057",
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const dryRun = searchParams.get("dry") === "true";

  try {
    let updated = 0;
    let notFound = 0;
    let alreadySet = 0;
    const results: { name: string; wallet: string; status: string }[] = [];

    for (const [name, wallet] of Object.entries(CSV_WALLET_MAPPINGS)) {
      // Skip invalid/short wallet addresses
      if (wallet.length < 10) {
        results.push({ name, wallet, status: "skipped (invalid wallet)" });
        continue;
      }

      // Check if entry exists in DB
      const existing = await sql`
        SELECT name, wallet FROM whale_watchlist WHERE LOWER(name) = ${name.toLowerCase()}
      `;

      if (existing.rows.length === 0) {
        notFound++;
        results.push({ name, wallet, status: "not in watchlist" });
        continue;
      }

      if (existing.rows[0].wallet) {
        alreadySet++;
        results.push({ name, wallet, status: "already has wallet" });
        continue;
      }

      // Update the wallet
      if (!dryRun) {
        await sql`
          UPDATE whale_watchlist
          SET wallet = ${wallet}
          WHERE LOWER(name) = ${name.toLowerCase()}
        `;
      }
      updated++;
      results.push({ name, wallet, status: dryRun ? "would update" : "updated" });
    }

    // Get updated stats
    const stats = await sql`
      SELECT
        COUNT(*) as total,
        COUNT(wallet) as with_wallet,
        COUNT(*) - COUNT(wallet) as pending_wallet
      FROM whale_watchlist
    `;

    return NextResponse.json({
      success: true,
      dryRun,
      updated,
      notFound,
      alreadySet,
      results,
      stats: {
        total: Number(stats.rows[0].total),
        withWallet: Number(stats.rows[0].with_wallet),
        pendingWallet: Number(stats.rows[0].pending_wallet),
      },
    });
  } catch (err) {
    console.error("Error importing CSV wallets:", err);
    return NextResponse.json(
      { error: "Failed to import wallets", details: String(err) },
      { status: 500 }
    );
  }
}
