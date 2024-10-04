export interface Schema {
  supply_total_unstaked: SupplyTotalUnstakedTable;
  supply_total_staked: SupplyTotalStakedTable;
}

export interface SupplyTotalUnstakedTable {
  /** The height for this supply information. */
  height: bigint;
  /** The amount of UM not in any other location (at this height). */
  um: bigint;
  /** The amount of UM in the auction component (at this height). */
  auction: bigint;
  /** The amount of UM in the dex component (at this height). */
  dex: bigint;
  /** The amount of UM locked away through protocol arb execution (up to this height). */
  arb: bigint;
  /** The amount of UM locked away through fees (up to this height). */
  fees: bigint;
}

export interface SupplyTotalStakedTable {
  /** Internal identifier for the validator. */
  validator_id: number;
  /** The height for this supply information. */
  height: bigint;
  /** The UM equivalent value of this validator's staking token. */
  um: bigint;
  /** The total amount of the delegation token staked with this validator. */
  del_um: bigint;
  /** The current exchange rate from del_um -> um, multiplied by 10^8. */
  rate_bps2: bigint;
}
