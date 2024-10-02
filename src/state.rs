pub mod database;

use database::Database;
use minijinja::Environment;
use serde::Serialize;

fn create_environment() -> anyhow::Result<Environment<'static>> {
    let mut environment = Environment::new();

    environment.add_template("index.html", include_str!("../templates/index.html"))?;

    Ok(environment)
}

/// Represents the state of our application.
#[derive(Debug, Clone)]
pub struct AppState {
    database: Database,
    environment: Environment<'static>,
}

impl AppState {
    /// Create an instance of this state.
    ///
    /// - `db_url` is used to connect to our postgres database.
    pub async fn create(db_url: &str) -> anyhow::Result<Self> {
        let database = Database::new(db_url).await?;
        let environment = create_environment()?;
        Ok(Self {
            database,
            environment,
        })
    }

    /// Get the database pool associated with this state.
    pub fn database(&self) -> Database {
        self.database.clone()
    }

    /// Render a template by name
    pub fn render_template<S: Serialize>(&self, name: &str, ctx: S) -> anyhow::Result<String> {
        Ok(self.environment.get_template(name)?.render(ctx)?)
    }
}
