mod common;
mod static_files;

use anyhow::anyhow;
use axum::{
    extract::{MatchedPath, Request, State},
    response::{Html, IntoResponse as _, Response},
    routing::get,
    Json, Router,
};
use common::AcceptsJson;
use core::net::SocketAddr;
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
    depositors: Depositors,
    shielded: ShieldedValue,
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
    fn format(registry: &Registry, value: TotalSupply) -> Self {
        let asset = &*penumbra_asset::STAKING_TOKEN_ASSET_ID;
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
}

impl FormattedDeposit {
    fn format(registry: &Registry, value: Deposit) -> anyhow::Result<Self> {
        let meta = registry.metadata(&value.asset);
        match meta {
            None => Ok(Self {
                asset: value.asset.to_string(),
                total: value.total.to_string(),
                current: value.current.to_string(),
                known: false,
            }),
            Some(meta) => Ok(Self {
                total: meta.format(&value.asset, value.total),
                current: meta.format(&value.asset, value.current),
                asset: meta.symbol.clone(),
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
    depositors: Depositors,
    shielded: FormattedShieldedValue,
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
        async move { db.asset_deposits().await }
    });
    let resp = IndexResponse {
        supply: supply_task.await??,
        depositors: depositors_task.await??,
        shielded: shielded_task.await??,
    };

    if json {
        Ok(Json(resp).into_response())
    } else {
        let registry = state.registry();
        let formatted = FormattedIndexResponse {
            supply: FormattedSupply::format(&registry, resp.supply),
            depositors: resp.depositors,
            shielded: FormattedShieldedValue::format(&registry, resp.shielded)?,
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
