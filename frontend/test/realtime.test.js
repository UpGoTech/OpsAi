import test from "node:test";

// Flow's Redis relay (`realtime/flow_handlers.js`) is not part of OpsAi's Hermes path;
// live updates come from polling `opsai.api.entries` instead (see stream.test.js).
test.skip("Flow realtime relay is unused with Hermes", () => {});
