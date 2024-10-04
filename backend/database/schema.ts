export interface Database {
  supply_total_unstaked: SupplyTotalUnstakedTable;
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
