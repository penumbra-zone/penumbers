use anyhow::Context;
use penumbra_asset::asset::Id as AssetId;
use penumbra_num::Amount;
use serde::Serialize;
use serde_with::{serde_as, DisplayFromStr};
use sqlx::PgPool;

#[derive(Clone, Debug, Serialize)]
pub struct TotalSupply {
    pub total: u64,
    pub unstaked: u64,
    pub staked: u64,
    pub auction: u64,
    pub dex: u64,
}

impl TotalSupply {
    pub async fn fetch(pool: &PgPool) -> anyhow::Result<Self> {
        let row: (i64, i64, i64, i64, i64) = sqlx::query_as(
            r#"
            SELECT 
                (staked_um + unstaked_um + auction + dex)::BIGINT as total,
                staked_um::BIGINT,
                (unstaked_um + auction + dex)::BIGINT,
                auction::BIGINT,
                dex::BIGINT
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
        "#,
        )
        .fetch_one(pool)
        .await?;
        Ok(Self {
            total: row.0.try_into()?,
            staked: row.1.try_into()?,
            unstaked: row.2.try_into()?,
            auction: row.3.try_into()?,
            dex: row.4.try_into()?,
        })
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
    pub cumulative: Amount,
    #[serde_as(as = "DisplayFromStr")]
    pub current: Amount,
}

#[derive(Debug, Clone, Serialize)]
pub struct AssetDeposits {
    pub deposits: Vec<Deposit>,
}

impl AssetDeposits {
    async fn fetch(pool: &PgPool) -> anyhow::Result<Self> {
        let out: Vec<(Vec<u8>, String, String)> = sqlx::query_as(
            r#"
            SELECT
                asset,
                SUM(amount)::TEXT,
                SUM(CASE WHEN kind = 'inbound' THEN amount ELSE 0 END)::TEXT
            FROM ibc_transfer
            GROUP BY asset
        "#,
        )
        .fetch_all(pool)
        .await?;
        let deposits = out
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
                    cumulative: Amount::try_from(x.2).context("failed to parse cumulative")?,
                })
            })
            .collect::<anyhow::Result<_>>()?;
        Ok(AssetDeposits { deposits })
    }
}

/// A database handle.
///
/// This is efficiently cloneable, internally reference counted.
#[derive(Clone, Debug)]
pub struct Database {
    pool: PgPool,
}

impl Database {
    pub async fn new(db_url: &str) -> anyhow::Result<Self> {
        let pool = PgPool::connect(db_url).await?;
        Ok(Self { pool })
    }

    pub async fn total_supply(&self) -> anyhow::Result<TotalSupply> {
        TotalSupply::fetch(&self.pool).await
    }

    pub async fn depositors(&self) -> anyhow::Result<Depositors> {
        Depositors::fetch(&self.pool).await
    }

    pub async fn asset_deposits(&self) -> anyhow::Result<AssetDeposits> {
        AssetDeposits::fetch(&self.pool).await
    }
}
