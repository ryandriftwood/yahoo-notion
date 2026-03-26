// rotowire-cli.js
// Standalone entry point for the Rotowire lineup sync.
// Run directly with: node rotowire-cli.js
// or via npm:        npm run sync:lineups

import { runLineupSync } from "./rotowire.js";

try {
  const result = await runLineupSync();
  console.log("[lineup] Done:", JSON.stringify(result));
  process.exit(0);
} catch (err) {
  console.error("[lineup] Error:", err?.message || err);
  process.exit(1);
}
