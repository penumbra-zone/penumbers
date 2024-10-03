use std::time::Duration;

use anyhow::{anyhow, Context};
use penumbra_asset::asset::Id as AssetId;
use penumbra_num::Amount;
use serde::Serialize;
use serde_with::{serde_as, DisplayFromStr};
use sqlx::PgPool;
use tokio::sync::watch;

#[derive(Clone, Debug, Serialize)]
pub struct TotalSupply {
    pub total: u64,
    pub unstaked: u64,
    pub staked: u64,
    pub auction: u64,
    pub dex: u64,
}

impl TotalSupply {
    pub async fn fetch(pool: &PgPool) -> anyhow::Result<(Self, Self)> {
        let row: (i64, i64, i64, i64, i64, i64, i64, i64, i64, i64) = sqlx::query_as(
            r#"
            SELECT 
                (staked_um + unstaked_um + auction + dex)::BIGINT as total,
                staked_um::BIGINT,
                (unstaked_um + auction + dex)::BIGINT,
                auction::BIGINT,
                dex::BIGINT,
                ((staked_um + unstaked_um + auction + dex)::NUMERIC * price)::BIGINT as total,
                (staked_um::NUMERIC * price)::BIGINT,
                ((unstaked_um + auction + dex)::NUMERIC * price)::BIGINT,
                (auction::NUMERIC * price)::BIGINT,
                (dex::NUMERIC * price)::BIGINT
            FROM (
              SELECT SUM(um) as staked_um
              FROM (
                SELECT * 
                FROM supply_validators
              ) validators
              LEFT JOIN LATERAL (
                SELECT um  
                FROM supply_total_staked
                WHERE validator_id = id 
                ORDER BY height DESC 
                LIMIT 1
              ) ON TRUE
            ) staked
            LEFT JOIN LATERAL (
              SELECT um as unstaked_um, auction, dex 
              FROM supply_total_unstaked
              ORDER BY HEIGHT DESC
              LIMIT 1
            ) on TRUE
            LEFT JOIN LATERAL (
                SELECT AVG(price21) as price FROM (
                    (SELECT 
                        price21 
                    FROM dex_lp 
                    WHERE state = 'opened'
                    AND asset1 = '\x76b3e4b10681358c123b381f90638476b7789040e47802de879f0fb3eedc8d0b' 
                    AND asset2 = '\x29ea9c2f3371f6a487e7e95c247041f4a356f983eb064e5d2b3bcf322ca96a10' 
                    AND reserves1 > 0 
                    ORDER BY price21 DESC
                    LIMIT 1)
                    UNION ALL
                    (SELECT 
                        price21 
                    FROM dex_lp 
                    WHERE state = 'opened'
                    AND asset1 = '\x76b3e4b10681358c123b381f90638476b7789040e47802de879f0fb3eedc8d0b' 
                    AND asset2 = '\x29ea9c2f3371f6a487e7e95c247041f4a356f983eb064e5d2b3bcf322ca96a10' 
                    AND reserves2 > 0 
                    ORDER BY price21 ASC
                    LIMIT 1)
                )
            ) on TRUE
        "#,
        )
        .fetch_one(pool)
        .await?;
        Ok((
            Self {
                total: row.0.try_into()?,
                staked: row.1.try_into()?,
                unstaked: row.2.try_into()?,
                auction: row.3.try_into()?,
                dex: row.4.try_into()?,
            },
            Self {
                total: row.5.try_into()?,
                staked: row.6.try_into()?,
                unstaked: row.7.try_into()?,
                auction: row.8.try_into()?,
                dex: row.9.try_into()?,
            },
        ))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Depositors {
    /// The number of unique depositors.
    pub total: u64,
}

impl Depositors {
    async fn fetch(pool: &PgPool) -> anyhow::Result<Self> {
        let res: i64 = sqlx::query_scalar("SELECT COUNT(DISTINCT foreign_addr) FROM ibc_transfer")
            .fetch_one(pool)
            .await?;
        Ok(Depositors {
            total: u64::try_from(res).context("failed to convert COUNT to u64")?,
        })
    }
}

#[serde_as]
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Deposit {
    #[serde_as(as = "DisplayFromStr")]
    pub asset: AssetId,
    #[serde_as(as = "DisplayFromStr")]
    pub total: Amount,
    #[serde_as(as = "DisplayFromStr")]
    pub current: Amount,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShieldedValue {
    pub by_asset: Vec<Deposit>,
}

impl ShieldedValue {
    async fn fetch(pool: &PgPool) -> anyhow::Result<Self> {
        let out: Vec<(Vec<u8>, String, String)> = sqlx::query_as(
            r#"
            SELECT
                asset,
                SUM(amount)::TEXT,
                SUM(CASE WHEN kind = 'inbound' THEN amount ELSE 0 END)::TEXT
            FROM ibc_transfer
            WHERE asset != $1
            GROUP BY asset
        "#,
        )
        .bind(penumbra_asset::STAKING_TOKEN_ASSET_ID.to_bytes())
        .fetch_all(pool)
        .await?;
        let by_asset = out
            .into_iter()
            .map(|x| {
                let current = if x.1.starts_with('-') {
                    Amount::default()
                } else {
                    Amount::try_from(x.1)?
                };
                Ok(Deposit {
                    asset: AssetId::try_from(x.0.as_slice()).context("failed to parse asset ID")?,
                    current,
                    total: Amount::try_from(x.2).context("failed to parse total")?,
                })
            })
            .collect::<anyhow::Result<_>>()?;
        Ok(ShieldedValue { by_asset })
    }

    async fn fetch_unshielded(pool: &PgPool) -> anyhow::Result<Self> {
        let out: Vec<(Vec<u8>, String, String)> = sqlx::query_as(
            r#"
            SELECT
                asset,
                (-SUM(amount))::TEXT,
                (-SUM(CASE WHEN kind = 'outbound' OR kind ilike '%refund%' THEN amount ELSE 0 END))::TEXT
            FROM ibc_transfer
            WHERE asset = $1
            GROUP BY asset
        "#,
        )
        .bind(penumbra_asset::STAKING_TOKEN_ASSET_ID.to_bytes())
        .fetch_all(pool)
        .await?;
        let by_asset = out
            .into_iter()
            .map(|x| {
                let current = if x.1.starts_with('-') {
                    Amount::default()
                } else {
                    Amount::try_from(x.1)?
                };
                Ok(Deposit {
                    asset: AssetId::try_from(x.0.as_slice()).context("failed to parse asset ID")?,
                    current,
                    total: Amount::try_from(x.2).context("failed to parse total")?,
                })
            })
            .collect::<anyhow::Result<_>>()?;
        Ok(ShieldedValue { by_asset })
    }
}

#[derive(Debug, Clone)]
struct Snapshot {
    total_supply: (TotalSupply, TotalSupply),
    depositors: Depositors,
    shielded_value: ShieldedValue,
    unshielded_value: ShieldedValue,
}

impl Snapshot {
    async fn fetch(pool: &PgPool) -> anyhow::Result<Self> {
        Ok(Self {
            total_supply: TotalSupply::fetch(pool).await?,
            depositors: Depositors::fetch(pool).await?,
            shielded_value: ShieldedValue::fetch(pool).await?,
            unshielded_value: ShieldedValue::fetch_unshielded(pool).await?,
        })
    }
}

#[derive(Debug)]
pub struct DatabaseWorker {
    pool: PgPool,
    snapshot_tx: watch::Sender<anyhow::Result<Snapshot>>,
}

impl DatabaseWorker {
    pub async fn run(self, poll_frequency_seconds: u64) -> anyhow::Result<()> {
        loop {
            tokio::time::sleep(Duration::from_secs(poll_frequency_seconds)).await;
            tracing::info!("updating database snapshot");
            self.snapshot_tx.send(Snapshot::fetch(&self.pool).await)?;
        }
    }
}

/// A database handle.
///
/// This is efficiently cloneable, internally reference counted.
#[derive(Clone, Debug)]
pub struct Database {
    snapshot_rx: watch::Receiver<anyhow::Result<Snapshot>>,
}

impl Database {
    pub async fn new(db_url: &str) -> anyhow::Result<(Self, DatabaseWorker)> {
        let pool = PgPool::connect(db_url).await?;
        let snapshot = Snapshot::fetch(&pool).await;
        let (snapshot_tx, snapshot_rx) = watch::channel(snapshot);
        Ok((Self { snapshot_rx }, DatabaseWorker { pool, snapshot_tx }))
    }

    async fn get_snapshot(&self) -> anyhow::Result<Snapshot> {
        match &*self.snapshot_rx.borrow() {
            Ok(x) => Ok(x.clone()),
            Err(e) => Err(anyhow!("{}", e)),
        }
    }

    pub async fn total_supply(&self) -> anyhow::Result<(TotalSupply, TotalSupply)> {
        Ok(self.get_snapshot().await?.total_supply)
    }

    pub async fn depositors(&self) -> anyhow::Result<Depositors> {
        Ok(self.get_snapshot().await?.depositors)
    }

    pub async fn shielded_value(&self) -> anyhow::Result<ShieldedValue> {
        Ok(self.get_snapshot().await?.shielded_value)
    }

    pub async fn unshielded_value(&self) -> anyhow::Result<ShieldedValue> {
        Ok(self.get_snapshot().await?.unshielded_value)
    }
}
