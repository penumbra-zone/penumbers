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

  const [unstaked, staked] = await Promise.all([unstakedP, stakedP]);
  return typedjson({
    total_supply: {
      total: unstaked.um + staked.um + unstaked.auction + unstaked.dex,
      unstaked: unstaked.um,
      staked: staked.um,
      auction: unstaked.auction,
      dex: unstaked.dex,
    },
  });
};

export const meta: MetaFunction = () => {
  return [{ title: "Penumbra Insights" }];
};

export default function Index() {
  const data = useTypedLoaderData<typeof loader>();
  return (
    <div className="flex flex-col h-screen items-center justify-center">
      <p>total: {`${data.total_supply.total}`}</p>
      <p>unstaked: {`${data.total_supply.unstaked}`}</p>
      <p>staked: {`${data.total_supply.staked}`}</p>
      <p>auction: {`${data.total_supply.auction}`}</p>
      <p>dex: {`${data.total_supply.dex}`}</p>
    </div>
  );
}
