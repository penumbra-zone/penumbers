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
    time: Date,
  ): Promise<ShieldedPoolSnapshot[]> {
    const rows = await db
      .selectFrom("insights_shielded_pool")
      .distinctOn("asset_id")
      .select(["asset_id", "total_value", "current_value", "unique_depositors"])
      .innerJoin(
        "block_details",
        "insights_shielded_pool.height",
        "block_details.height",
      )
      .orderBy(["asset_id", "block_details.height desc"])
      .where("timestamp", "<=", time)
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

class ShieldedPoolTimedSnapshots {
  constructor(
    public now: ShieldedPoolSnapshot,
    public h24: ShieldedPoolSnapshot,
    public d7: ShieldedPoolSnapshot,
    public d30: ShieldedPoolSnapshot,
  ) {}

  static async fetch(
    db: Database,
    registry: Registry,
  ): Promise<ShieldedPoolTimedSnapshots[]> {
    const now = new Date();
    const ago24h = new Date(now.getTime());
    ago24h.setHours(ago24h.getHours() - 24);
    const ago7d = new Date(now.getTime());
    ago7d.setDate(ago7d.getDate() - 7);
    const ago30d = new Date(now.getTime());
    ago30d.setDate(ago30d.getDate() - 30);

    const [arr, arr24h, arr7d, arr30d] = await Promise.all(
      [now, ago24h, ago7d, ago30d].map((x) =>
        ShieldedPoolSnapshot.fetchKnownAssets(db, registry, x),
      ),
    );
    // Convert a list for each time into a list containing a value for each time, per asset.
    const partialSnapshots: Map<
      string,
      Partial<ShieldedPoolTimedSnapshots>
    > = new Map();
    for (const [k, list] of Object.entries({
      now: arr,
      h24: arr24h,
      d7: arr7d,
      d30: arr30d,
    })) {
      for (const snapshot of list) {
        if (snapshot.total.valueView.case !== "knownAssetId") {
          continue;
        }
        const id = snapshot.total.valueView.value.metadata!.base;
        const object = partialSnapshots.get(id) ?? {};
        object[k as keyof ShieldedPoolTimedSnapshots] = snapshot;
        partialSnapshots.set(id, object);
      }
    }
    const out = [];
    for (const x of partialSnapshots.values()) {
      if (!x.d7 || !x.d30 || !x.h24 || !x.now) {
        continue;
      }
      out.push(new ShieldedPoolTimedSnapshots(x.now, x.h24, x.d7, x.d30));
    }

    return out;
  }

  static fromJson(
    data: Jsonified<ShieldedPoolTimedSnapshots>,
  ): ShieldedPoolTimedSnapshots {
    return new ShieldedPoolTimedSnapshots(
      ShieldedPoolSnapshot.fromJson(data.now),
      ShieldedPoolSnapshot.fromJson(data.h24),
      ShieldedPoolSnapshot.fromJson(data.d7),
      ShieldedPoolSnapshot.fromJson(data.d30),
    );
  }
}

class Data {
  constructor(
    public supply: Supply,
    public shieldedPool: ShieldedPoolTimedSnapshots[],
  ) {}

  static async fetch(db: Database, registry: Registry): Promise<Data> {
    const [supply, shieldedPool] = await Promise.all([
      Supply.fetch(db, registry),
      ShieldedPoolTimedSnapshots.fetch(db, registry),
    ]);
    return new Data(supply, shieldedPool);
  }

  static fromJson(data: Jsonified<Data>): Data {
    return new Data(
      Supply.fromJson(data.supply),
      data.shieldedPool.map(ShieldedPoolTimedSnapshots.fromJson),
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

const ShowShielded = ({
  shielded,
}: {
  shielded: ShieldedPoolTimedSnapshots[];
}) => {
  const sorted = [...shielded].sort((a, b) =>
    a.now.priority === b.now.priority
      ? b.now.unique_depositors - a.now.unique_depositors
      : b.now.priority - a.now.priority,
  );

  return (
    <Card title="Shielded Pool">
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>total / current </Table.Th>
            <Table.Th>depositors</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {sorted.map((x, i) => (
            <Table.Tr key={i}>
              <Table.Th>
                <div className="flex flex-col gap-y-2">
                  <ValueViewComponent valueView={x.now.total} />
                  <ValueViewComponent valueView={x.now.current} />
                </div>
              </Table.Th>
              <Table.Th>{x.now.unique_depositors}</Table.Th>
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
