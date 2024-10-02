mod common;
mod static_files;

use axum::{
    extract::{MatchedPath, Request, State},
    response::{Html, IntoResponse as _, Response},
    routing::get,
    Json, Router,
};
use common::AcceptsJson;
use core::net::SocketAddr;
use serde::Serialize;
use tower_http::trace::TraceLayer;
use tracing::info_span;

use crate::state::{
    database::{AssetDeposits, TotalSupply},
    AppState,
};
use crate::{error::Result, state::database::Depositors};

#[derive(Debug, Clone, Serialize)]
struct IndexResponse {
    supply: TotalSupply,
    depositors: Depositors,
    asset_deposits: AssetDeposits,
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
    let asset_deposits_task = tokio::spawn({
        let db = state.database();
        async move { db.asset_deposits().await }
    });
    let resp = IndexResponse {
        supply: supply_task.await??,
        depositors: depositors_task.await??,
        asset_deposits: asset_deposits_task.await??,
    };

    if json {
        Ok(Json(resp).into_response())
    } else {
        Ok(Html(state.render_template("index.html", resp)?).into_response())
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
