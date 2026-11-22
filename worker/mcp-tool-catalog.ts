// The tools the MCP server registers, by grant. This module has no imports so the browser guide
// can count tools without bundling the server; worker/mcp.test.ts checks it against tools/list.
export const READ_TOOLS = [
  'get_lobster_prices',
  'get_ledger',
  'list_bets',
  'get_bet',
  'get_balances',
  'get_leaderboard',
  'list_prices',
] as const;
export const WRITE_TOOLS = [
  'create_bet',
  'act_on_bet',
  'add_restaurant',
  'record_price',
  'correct_price',
  'withdraw_price',
] as const;
export const READ_TOOL_COUNT = READ_TOOLS.length;
export const WRITE_TOOL_COUNT = WRITE_TOOLS.length;
