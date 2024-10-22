import { Table } from "@penumbra-zone/ui/Table";
import type { MetaFunction } from "@remix-run/node";
import { Database, db, Schema } from "backend/database";
import { QueryCreator } from "kysely";
import { splitLoHi } from "@penumbra-zone/types/lo-hi";
import {
  AssetId,
  Metadata,
  ValueView,
  ValueView_KnownAssetId,
} from "@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb";
import { Amount } from "@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb";
import { useLoaderData } from "@remix-run/react";
import { Jsonified } from "@penumbra-zone/types/jsonified";
import { ChainRegistryClient, Registry } from "@penumbra-labs/registry";
import { multiplyAmountByNumber } from "@penumbra-zone/types/amount";
import { PenumbraUIProvider } from "@penumbra-zone/ui/PenumbraUIProvider";
import { ValueViewComponent } from "@penumbra-zone/ui/ValueViewComponent";
import { Grid } from "@penumbra-zone/ui/Grid";
import { Card } from "@penumbra-zone/ui/Card";
import { Density } from "@penumbra-zone/ui/Density";
import { getFormattedAmtFromValueView } from "@penumbra-zone/types/value-view";
import { Display } from "@penumbra-zone/ui/Display";

function knownValueView(metadata: Metadata, amount: Amount): ValueView {
  return new ValueView({
    valueView: {
      case: "knownAssetId",
      value: new ValueView_KnownAssetId({ amount, metadata }),
    },
  });
}

/**
 * Information about the total supply of the native token.
 */
class Supply {
  constructor(
    public total: ValueView,
    public staked_percentage: number,
    public price: number,
    public market_cap: number,
  ) {}

  static async fetch(db: Database, registry: Registry): Promise<Supply> {
    const { total, staked, price, market_cap } = await db
      .selectFrom("insights_supply")
      .select(["total", "staked", "price", "market_cap"])
      .orderBy("height desc")
      .limit(1)
      .executeTakeFirstOrThrow();
    const umMetadata = registry.getAllAssets().find((x) => x.symbol === "UM")!;
    return new Supply(
      knownValueView(umMetadata, new Amount(splitLoHi(total))),
      Number(staked) / Number(total),
      price,
      market_cap,
    );
  }

  static fromJson(data: Jsonified<Supply>): Supply {
    return new Supply(
      ValueView.fromJson(data.total),
      data.staked_percentage,
      data.price,
      data.market_cap,
    );
  }
}

/**
 * A snapshot of the shielded pool, at a specific point in time.
 */
class ShieldedPoolSnapshot {
  constructor(
    public total: ValueView,
    public current: ValueView,
    public priority: number,
    public unique_depositors: number,
  ) {}

  static async fetchKnownAssets(
    db: Database,
    registry: Registry,
  ): Promise<ShieldedPoolSnapshot[]> {
    const rows = await db
      .selectFrom("insights_shielded_pool")
      .distinctOn("asset_id")
      .select(["asset_id", "total_value", "current_value", "unique_depositors"])
      .orderBy(["asset_id", "height desc"])
      .execute();
    const out: ShieldedPoolSnapshot[] = [];
    for (const row of rows) {
      let metadata: Metadata;
      // Stupid, but the API doesn't return an optional value here.
      try {
        metadata = registry.getMetadata(new AssetId({ inner: row.asset_id }));
      } catch (e) {
        continue;
      }
      out.push(
        new ShieldedPoolSnapshot(
          knownValueView(
            metadata,
            new Amount(splitLoHi(BigInt(row.total_value))),
          ),
          knownValueView(
            metadata,
            new Amount(splitLoHi(BigInt(row.current_value))),
          ),
          Number(metadata.priorityScore),
          row.unique_depositors,
        ),
      );
    }
    return out;
  }

  static fromJson(data: Jsonified<ShieldedPoolSnapshot>): ShieldedPoolSnapshot {
    return new ShieldedPoolSnapshot(
      ValueView.fromJson(data.total),
      ValueView.fromJson(data.current),
      data.priority,
      data.unique_depositors,
    );
  }
}

class Data {
  constructor(
    public supply: Supply,
    public shieldedPool: ShieldedPoolSnapshot[],
  ) {}

  static async fetch(db: Database, registry: Registry): Promise<Data> {
    const [supply, shieldedPool] = await Promise.all([
      Supply.fetch(db, registry),
      ShieldedPoolSnapshot.fetchKnownAssets(db, registry),
    ]);
    return new Data(supply, shieldedPool);
  }

  static fromJson(data: Jsonified<Data>): Data {
    return new Data(
      Supply.fromJson(data.supply),
      data.shieldedPool.map(ShieldedPoolSnapshot.fromJson),
    );
  }
}

export const loader = async (): Promise<Data> => {
  const registry = await new ChainRegistryClient().remote.get("penumbra-1");
  const data = await Data.fetch(db, registry);
  return data;
};

const ShowSupply = ({ supply }: { supply: Supply }) => {
  return (
    <Card title="Supply">
      <Table tableLayout="fixed">
        <Table.Tbody>
          <Table.Tr>
            <Table.Th>{"total"}</Table.Th>
            <Table.Td>
              <ValueViewComponent valueView={supply.total} />
            </Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Th>{"staked"}</Table.Th>
            <Table.Td>{(100 * supply.staked_percentage).toFixed(2)}%</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Th>{"price"}</Table.Th>
            <Table.Td>{supply.price}</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Th>{"market_cap"}</Table.Th>
            <Table.Td>{supply.market_cap}</Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
    </Card>
  );
};

const ShowShielded = ({ shielded }: { shielded: ShieldedPoolSnapshot[] }) => {
  const sorted = [...shielded].sort((a, b) =>
    a.priority === b.priority
      ? b.unique_depositors - a.unique_depositors
      : b.priority - a.priority,
  );

  return (
    <Card title="Shielded Pool">
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>total</Table.Th>
            <Table.Th>current</Table.Th>
            <Table.Th>depositors</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {sorted.map((x, i) => (
            <Table.Tr key={i}>
              <Table.Th>
                <ValueViewComponent valueView={x.total} />
              </Table.Th>
              <Table.Th>
                <ValueViewComponent valueView={x.current} />
              </Table.Th>
              <Table.Th>{x.unique_depositors}</Table.Th>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  );
};

export const meta: MetaFunction = () => {
  return [{ title: "Penumbra Insights" }];
};

export default function Index() {
  const raw = useLoaderData<Jsonified<Data>>();
  const data = Data.fromJson(raw);
  return (
    <PenumbraUIProvider>
      <Display>
        <Density compact>
          <Grid container as="main">
            <Grid lg={6}>
              <ShowSupply supply={data.supply} />
            </Grid>
            <Grid lg={6}>
              <ShowShielded shielded={data.shieldedPool} />
            </Grid>
          </Grid>
        </Density>
      </Display>
    </PenumbraUIProvider>
  );
}
