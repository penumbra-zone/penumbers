use anyhow::anyhow;
use penumbra_asset::asset::{Id as AssetId, Metadata};
use penumbra_num::Amount;
use penumbra_proto::core::asset::v1 as pb;
use serde_json::Value;
use std::{collections::HashMap, str::FromStr, sync::Arc};

/// Represents the metadata we need for nicely formatting assets.
#[derive(Debug, Clone)]
pub struct AugmentedMetadata {
    pub metadata: Metadata,
    pub symbol: String,
    pub images: Vec<pb::AssetImage>,
}

impl AugmentedMetadata {
    pub fn format(&self, _asset: &AssetId, amount: impl Into<Amount>) -> String {
        let amount = amount.into();
        self.metadata.default_unit().format_value(amount)
    }

    pub fn format_with_symbol(&self, asset: &AssetId, amount: impl Into<Amount>) -> String {
        format!("{} {}", self.format(asset, amount), &self.symbol)
    }

    pub fn image(&self) -> Option<String> {
        for image in &self.images {
            if image.png != "" {
                return Some(image.png.clone());
            }
        }
        for image in &self.images {
            if image.svg != "" {
                return Some(image.svg.clone());
            }
        }
        return None;
    }
}

type MetadataMap = HashMap<AssetId, AugmentedMetadata>;

fn parse_metadata_map(s: &str) -> anyhow::Result<HashMap<AssetId, AugmentedMetadata>> {
    let raw: Value = serde_json::from_slice(s.as_bytes())?;
    let asset_map = raw
        .as_object()
        .ok_or(anyhow!("expected object"))?
        .get_key_value("assetById")
        .ok_or(anyhow!("expected key 'assetById'"))?
        .1
        .as_object()
        .ok_or(anyhow!("expected object"))?;
    asset_map
        .values()
        .map(|v| {
            let pb_meta: pb::Metadata = serde_json::from_value(v.clone())?;
            let metadata: Metadata = pb_meta.clone().try_into()?;
            let asset_id = pb_meta
                .penumbra_asset_id
                .ok_or(anyhow!("expected 'penumbra_asset_id'"))?
                .try_into()?;
            let augmented = AugmentedMetadata {
                metadata,
                symbol: pb_meta.symbol,
                images: pb_meta.images,
            };
            Ok((asset_id, augmented))
        })
        .collect()
}

/// Represents a registry of asset metadata.
///
/// Efficiently cloneable.
#[derive(Clone, Debug)]
pub struct Registry {
    map: Arc<MetadataMap>,
}

impl Registry {
    fn new(map: MetadataMap) -> Self {
        Self { map: Arc::new(map) }
    }

    /// Return the asset registry associated with the Penumbra 1 chain.
    pub fn from_penumbra_1() -> anyhow::Result<Self> {
        Self::from_str(include_str!("./registry/chains/penumbra-1.json"))
    }

    /// Attempt to get the metadata associated with a given asset.
    pub fn metadata(&self, asset: &AssetId) -> Option<&AugmentedMetadata> {
        self.map.get(asset)
    }
}

impl FromStr for Registry {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        parse_metadata_map(s).map(Registry::new)
    }
}
