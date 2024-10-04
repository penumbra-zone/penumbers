import { Table } from "@penumbra-zone/ui/Table";
import type { MetaFunction } from "@remix-run/node";
import { db, Schema } from "backend/database";
import { QueryCreator } from "kysely";
import { splitLoHi } from "@penumbra-zone/types/lo-hi";
import {
  Metadata,
  ValueView,
  ValueView_KnownAssetId,
} from "@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb";
import { Amount } from "@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb";
import { useLoaderData } from "@remix-run/react";
import { Jsonified } from "@penumbra-zone/types/jsonified";
import { ChainRegistryClient } from "@penumbra-labs/registry";
import { multiplyAmountByNumber } from "@penumbra-zone/types/amount";
import { PenumbraUIProvider } from "@penumbra-zone/ui/PenumbraUIProvider";
import { ValueViewComponent } from "@penumbra-zone/ui/ValueViewComponent";
import { Grid } from "@penumbra-zone/ui/Grid";
import { Text } from "@penumbra-zone/ui/Text";
import { Card } from "@penumbra-zone/ui/Card";
import { Density } from "@penumbra-zone/ui/Density";
import { getFormattedAmtFromValueView } from "@penumbra-zone/types/value-view";

const REGISTRY = new ChainRegistryClient().bundled.get("penumbra-1");
const UM_METADATA = REGISTRY.getAllAssets().find((x) => x.symbol === "UM")!;
const USDC_METADATA = REGISTRY.getAllAssets().find((x) => x.symbol === "USDC")!;
if (!UM_METADATA) {
  throw new Error("UM not present in registry");
}
if (!USDC_METADATA) {
  throw new Error("USDC not present in registry");
}
const METADATA_MAP = new Map(
  REGISTRY.getAllAssets().map((x) => [x.penumbraAssetId?.inner.toString(), x])
);

function knownValueView(metadata: Metadata, amount: Amount): ValueView {
  return new ValueView({
    valueView: {
      case: "knownAssetId",
      value: new ValueView_KnownAssetId({ amount, metadata }),
    },
  });
}

interface TotalSupply {
  total: ValueView;
  staked: ValueView;
  unstaked: ValueView;
  auction: ValueView;
  dex: ValueView;
}

async function fetchTotalSupply(): Promise<[TotalSupply, TotalSupply]> {
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
    .select(({ fn }) => fn.sum<string>("staked.um").as("um"))
    .executeTakeFirstOrThrow()
    .then((x) => BigInt(x.um));

  const buyPriceQ = db
    .selectFrom("dex_lp")
    .select("price21")
    .where("state", "=", "opened")
    .where("asset1", "=", USDC_METADATA?.penumbraAssetId?.inner!)
    .where("asset2", "=", UM_METADATA?.penumbraAssetId?.inner!)
    .where("reserves1", ">", 0n)
    .orderBy("price21", "desc");
  const buyPriceP = buyPriceQ.executeTakeFirstOrThrow();
  const sellPriceP = db
    .selectFrom("dex_lp")
    .select("price21")
    .where("state", "=", "opened")
    .where("asset1", "=", USDC_METADATA?.penumbraAssetId?.inner!)
    .where("asset2", "=", UM_METADATA?.penumbraAssetId?.inner!)
    .where("reserves2", ">", 0n)
    .orderBy("price21", "asc")
    .executeTakeFirstOrThrow();

  const [unstaked, staked, buyPrice, sellPrice] = await Promise.all([
    unstakedP,
    stakedP,
    buyPriceP,
    sellPriceP,
  ]);
  const price = (Number(buyPrice.price21) + Number(sellPrice.price21)) / 2;

  const bigints = Object.values({
    total: unstaked.um + staked + unstaked.auction + unstaked.dex,
    unstaked: unstaked.um,
    staked: staked,
    auction: unstaked.auction,
    dex: unstaked.dex,
  });
  const amounts = bigints.map((x) => new Amount(splitLoHi(x)));
  const um = amounts.map((x) => knownValueView(UM_METADATA, x));
  const usdc = amounts.map((x) =>
    knownValueView(USDC_METADATA, multiplyAmountByNumber(x, price))
  );
  return [
    {
      total: um[0],
      unstaked: um[1],
      staked: um[2],
      auction: um[3],
      dex: um[4],
    },
    {
      total: usdc[0],
      unstaked: usdc[1],
      staked: usdc[2],
      auction: usdc[3],
      dex: usdc[4],
    },
  ];
}

function hydrateTotalSupply(data: Jsonified<TotalSupply>): TotalSupply {
  return {
    total: ValueView.fromJson(data.total),
    unstaked: ValueView.fromJson(data.unstaked),
    staked: ValueView.fromJson(data.staked),
    auction: ValueView.fromJson(data.auction),
    dex: ValueView.fromJson(data.dex),
  };
}

const ShowTotalSupply = ({
  um,
  usdc,
}: {
  um: TotalSupply;
  usdc: TotalSupply;
}) => {
  return (
    <Card title="supply">
      <Table>
        <Table.Tbody>
          {Object.keys(um).map((k) => {
            return (
              <Table.Tr>
                <Table.Th>{k}</Table.Th>
                <Table.Td>
                  <ValueViewComponent valueView={(um as any)[k]} />
                </Table.Td>
                <Table.Td>
                  <ValueViewComponent valueView={(usdc as any)[k]} />
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Card>
  );
};

interface Depositors {
  unique: number;
}

async function fetchDepositors(): Promise<Depositors> {
  const res = await db
    .selectFrom("ibc_transfer")
    .select(({ fn }) =>
      fn.count<number>("foreign_addr").distinct().as("depositors")
    )
    .where("kind", "=", "inbound")
    .executeTakeFirstOrThrow();
  return { unique: Number(res.depositors) };
}

const ShowDepositors = ({ depositors }: { depositors: Depositors }) => {
  return (
    <Card title="depositors">
      <Table>
        <Table.Tbody>
          <Table.Tr>
            <Table.Th>unique</Table.Th>
            <Table.Td>{depositors.unique}</Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
    </Card>
  );
};

interface Shielded {
  total: ValueView;
  current: ValueView;
}

async function fetchShielded(): Promise<Shielded[]> {
  const out = await db
    .selectFrom("ibc_transfer")
    .select((eb) => [
      "asset",
      eb.fn.sum<string>("amount").as("current"),
      eb.fn
        .sum<string>(
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
  return out
    .map(({ asset, total, current }) => {
      const metadata =
        METADATA_MAP.get(new Uint8Array(asset).toString()) ?? null;
      if (metadata === null) {
        return null;
      }
      const totaln = BigInt(total);
      const currentn = BigInt(current);
      if (totaln < 0 || currentn < 0) {
        return null;
      }
      return {
        total: knownValueView(metadata, new Amount(splitLoHi(totaln))),
        current: knownValueView(metadata, new Amount(splitLoHi(currentn))),
      };
    })
    .filter((x) => x !== null);
}

function hydrateShielded(data: Jsonified<Shielded>): Shielded {
  return {
    total: ValueView.fromJson(data.total),
    current: ValueView.fromJson(data.current),
  };
}

const ShowShielded = ({ shielded }: { shielded: Shielded[] }) => {
  const arr = [...shielded];
  arr.sort(
    (a, b) =>
      Number(getFormattedAmtFromValueView(b.total)) -
      Number(getFormattedAmtFromValueView(a.total)) // TODO: optimize
  );
  return (
    <Card title="shielded">
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>total</Table.Th>
            <Table.Th>current</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {arr.map((x) => {
            return (
              <Table.Tr>
                <Table.Td>
                  <ValueViewComponent valueView={x.total} />
                </Table.Td>
                <Table.Td>
                  <ValueViewComponent valueView={x.current} />
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Card>
  );
};

interface Data {
  totalSupplyUM: TotalSupply;
  totalSupplyUSDC: TotalSupply;
  depositors: Depositors;
  shielded: Shielded[];
}

async function fetchData(): Promise<Data> {
  const totalSupplyP = fetchTotalSupply();
  const depositorsP = fetchDepositors();
  const shieldedP = fetchShielded();
  const [[totalSupplyUM, totalSupplyUSDC], depositors, shielded] =
    await Promise.all([totalSupplyP, depositorsP, shieldedP]);
  return {
    totalSupplyUM,
    totalSupplyUSDC,
    depositors,
    shielded,
  };
}

function hydrateData(raw: Jsonified<Data>): Data {
  return {
    totalSupplyUSDC: hydrateTotalSupply(raw.totalSupplyUSDC),
    totalSupplyUM: hydrateTotalSupply(raw.totalSupplyUM),
    depositors: raw.depositors,
    shielded: raw.shielded.map(hydrateShielded),
  };
}

export const loader = async (): Promise<Data> => {
  const data = await fetchData();
  return data;
};

export const meta: MetaFunction = () => {
  return [{ title: "Penumbra Insights" }];
};

interface SupplyProps {
  total: Amount;
}

export default function Index() {
  const raw = useLoaderData<Jsonified<Data>>();
  const data = hydrateData(raw);
  return (
    <PenumbraUIProvider>
      <Density compact>
        <Grid container as="main">
          <Grid mobile={12} desktop={6}>
            <ShowTotalSupply
              um={data.totalSupplyUM}
              usdc={data.totalSupplyUSDC}
            />
          </Grid>
          <Grid mobile={12} desktop={6}>
            <ShowDepositors depositors={data.depositors} />
          </Grid>
          <Grid mobile={12} desktop={6}>
            <ShowShielded shielded={data.shielded} />
          </Grid>
        </Grid>
      </Density>
    </PenumbraUIProvider>
  );
}
