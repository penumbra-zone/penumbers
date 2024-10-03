mod common;
mod static_files;

use anyhow;
use axum::{
    extract::{MatchedPath, Request, State},
    response::{Html, IntoResponse as _, Response},
    routing::get,
    Json, Router,
};
use common::AcceptsJson;
use core::net::SocketAddr;
use penumbra_asset::{asset::Id as AssetId, STAKING_TOKEN_ASSET_ID};
use serde::Serialize;
use sqlx::types::BigDecimal;
use std::str::FromStr;
use tower_http::trace::TraceLayer;
use tracing::info_span;

use crate::state::{
    database::{Deposit, ShieldedValue, TotalSupply},
    registry::Registry,
    AppState,
};
use crate::{error::Result, state::database::Depositors};

#[derive(Debug, Clone, Serialize)]
struct IndexResponse {
    supply: TotalSupply,
    usdc_equivalent_supply: TotalSupply,
    depositors: Depositors,
    shielded: ShieldedValue,
    unshielded: ShieldedValue,
}

#[derive(Debug, Clone, Serialize)]
struct FormattedSupply {
    total: String,
    unstaked: String,
    staked: String,
    auction: String,
    dex: String,
}

impl FormattedSupply {
    fn format(registry: &Registry, asset: &AssetId, value: TotalSupply) -> Self {
        let meta = registry
            .metadata(asset)
            .expect("staking token should be in registry");
        Self {
            total: meta.format_with_symbol(asset, value.total),
            unstaked: meta.format_with_symbol(asset, value.unstaked),
            staked: meta.format_with_symbol(asset, value.staked),
            auction: meta.format_with_symbol(asset, value.auction),
            dex: meta.format_with_symbol(asset, value.dex),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct FormattedDeposit {
    pub asset: String,
    pub total: String,
    pub current: String,
    pub known: bool,
    pub image: String,
}

impl FormattedDeposit {
    fn format(registry: &Registry, value: Deposit) -> anyhow::Result<Self> {
        let meta = registry.metadata(&value.asset);
        let black_image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==".to_string();
        match meta {
            None => Ok(Self {
                asset: value.asset.to_string(),
                total: value.total.to_string(),
                current: value.current.to_string(),
                image: black_image,
                known: false,
            }),
            Some(meta) => Ok(Self {
                total: meta.format(&value.asset, value.total),
                current: meta.format(&value.asset, value.current),
                asset: meta.symbol.clone(),
                image: meta.image().unwrap_or(black_image),
                known: true,
            }),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct FormattedShieldedValue {
    by_asset: Vec<FormattedDeposit>,
    unknown_asset: Vec<FormattedDeposit>,
}

impl FormattedShieldedValue {
    fn format(registry: &Registry, value: ShieldedValue) -> anyhow::Result<Self> {
        let all: Vec<FormattedDeposit> = value
            .by_asset
            .into_iter()
            .map(|x| FormattedDeposit::format(registry, x))
            .collect::<anyhow::Result<_>>()?;
        let mut by_asset = Vec::new();
        let mut unknown_asset = Vec::new();
        for deposit in all {
            if deposit.known {
                by_asset.push(deposit);
            } else {
                unknown_asset.push(deposit);
            }
        }
        by_asset.sort_by_key(|x| std::cmp::Reverse(BigDecimal::from_str(&x.total).ok()));
        Ok(Self {
            by_asset,
            unknown_asset,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
struct FormattedIndexResponse {
    supply: FormattedSupply,
    usdc_equivalent_supply: FormattedSupply,
    depositors: Depositors,
    shielded: FormattedShieldedValue,
    unshielded: FormattedShieldedValue,
}

async fn index_handler(
    State(state): State<AppState>,
    AcceptsJson(json): AcceptsJson,
) -> Result<Response> {
    let supply_task = tokio::spawn({
        let db = state.database();
        async move { db.total_supply().await }
    });
    let depositors_task = tokio::spawn({
        let db = state.database();
        async move { db.depositors().await }
    });
    let shielded_task = tokio::spawn({
        let db = state.database();
        async move { db.shielded_value().await }
    });
    let unshielded_task = tokio::spawn({
        let db = state.database();
        async move { db.unshielded_value().await }
    });
    let (supply, usdc_equivalent_supply) = supply_task.await??;
    let resp = IndexResponse {
        supply,
        usdc_equivalent_supply,
        depositors: depositors_task.await??,
        shielded: shielded_task.await??,
        unshielded: unshielded_task.await??,
    };

    if json {
        Ok(Json(resp).into_response())
    } else {
        let registry = state.registry();
        let formatted = FormattedIndexResponse {
            supply: FormattedSupply::format(&registry, &*STAKING_TOKEN_ASSET_ID, resp.supply),
            usdc_equivalent_supply: FormattedSupply::format(
                &registry,
                &AssetId::from_str(
                    "passet1w6e7fvgxsy6ccy3m8q0eqcuyw6mh3yzqu3uq9h58nu8m8mku359spvulf6",
                )?,
                resp.usdc_equivalent_supply,
            ),
            depositors: resp.depositors,
            shielded: FormattedShieldedValue::format(&registry, resp.shielded)?,
            unshielded: FormattedShieldedValue::format(&registry, resp.unshielded)?,
        };
        Ok(Html(state.render_template("index.html", formatted)?).into_response())
    }
}

/// Represents the configuration of the web server.
///
/// This is the entry point to the frontend, and running it will serve the web pages.
pub struct WebServer {
    address: SocketAddr,
    state: AppState,
}

impl WebServer {
    pub fn new(state: AppState, address: SocketAddr) -> Self {
        Self { state, address }
    }

    #[allow(dead_code)]
    pub fn with_address(mut self, addr: SocketAddr) -> Self {
        self.address = addr;
        self
    }

    pub async fn run(self) -> anyhow::Result<()> {
        let app = Router::new()
            .route("/", get(index_handler))
            .nest("/static", static_files::router())
            .with_state(self.state)
            .layer(
                TraceLayer::new_for_http().make_span_with(|request: &Request<_>| {
                    // Log the matched route's path (with placeholders not filled in).
                    // Use request.uri() or OriginalUri if you want the real path.
                    let map = request
                        .extensions()
                        .get::<MatchedPath>()
                        .map(MatchedPath::as_str);
                    let matched_path = map;

                    info_span!(
                        "http",
                        method = ?request.method(),
                        matched_path,
                    )
                }),
            );

        let listener = tokio::net::TcpListener::bind(self.address).await?;
        axum::serve(listener, app).await?;
        Ok(())
    }
}
