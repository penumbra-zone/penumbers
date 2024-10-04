import { Table } from "@penumbra-zone/ui/Table";
import type { MetaFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Database, db, Schema } from "backend/database";
import { QueryCreator } from "kysely";
import { typedjson, useTypedLoaderData } from "remix-typedjson";

export const loader = async () => {
  const unstakedP = db
    .selectFrom("supply_total_unstaked")
    .orderBy("height", "desc")
    .select(["um", "auction", "dex"])
    .limit(1)
    .executeTakeFirstOrThrow();

  const stakedWithValidator = (db: QueryCreator<Schema>) => {
    return db
      .selectFrom("supply_total_staked")
      .orderBy(["validator_id", "height desc"])
      .select(["validator_id", "um"])
      .distinctOn("validator_id");
  };
  const stakedP = db
    .with("staked", stakedWithValidator)
    .selectFrom("staked")
    .select(({ fn }) => fn.sum<bigint>("staked.um").as("um"))
    .executeTakeFirstOrThrow();

  const depositorsP = db
    .selectFrom("ibc_transfer")
    .select(({ fn }) =>
      fn.count<number>("foreign_addr").distinct().as("depositors")
    )
    .where("kind", "=", "inbound")
    .executeTakeFirstOrThrow();

  const shieldedP = db
    .selectFrom("ibc_transfer")
    .select((eb) => [
      "asset",
      eb.fn.sum<bigint>("amount").as("current"),
      eb.fn
        .sum<bigint>(
          eb
            .case()
            .when("kind", "=", "inbound")
            .then(eb.ref("amount"))
            .else(0n)
            .end()
        )
        .as("total"),
    ])
    .groupBy("asset")
    .execute();

  const [unstaked, staked, { depositors }, shielded] = await Promise.all([
    unstakedP,
    stakedP,
    depositorsP,
    shieldedP,
  ]);
  return typedjson({
    total_supply: {
      total: unstaked.um + staked.um + unstaked.auction + unstaked.dex,
      unstaked: unstaked.um,
      staked: staked.um,
      auction: unstaked.auction,
      dex: unstaked.dex,
    },
    depositors,
    shielded,
  });
};

export const meta: MetaFunction = () => {
  return [{ title: "Penumbra Insights" }];
};

export default function Index() {
  const data = useTypedLoaderData<typeof loader>();
  return (
    <div className="flex flex-col h-screen items-center justify-center">
    </div>
  );
}
