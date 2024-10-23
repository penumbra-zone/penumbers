export interface Schema {
  insights_shielded_pool: ShieldedPoolTable;
  insights_supply: SupplyTable;
  block_details: BlockDetails;
}

export interface ShieldedPoolTable {
  /** The height of this information. */
  height: bigint;
  /** The asset being shielded. */
  asset_id: Uint8Array;
  /** Total amount of this asset ever shielded. */
  total_value: string;
  /** The current value in the shielded pool. */
  current_value: string;
  /** The number of unique depositors for this asset. */
  unique_depositors: number;
}

export interface SupplyTable {
  /** The height of this information. */
  height: bigint;
  /** The total amount of the native token in existence. */
  total: bigint;
  /** Of this amount, how much is currently staked. */
  staked: bigint;
}

export interface BlockDetails {
  height: bigint;
  root: Uint8Array;
  timestamp: Date;
}
