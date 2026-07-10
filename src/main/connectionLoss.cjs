// Single source of truth for classifying a remote-operation failure as a
// dropped/refused connection (vs. an ordinary error: missing file, conflict,
// auth, …). Required by the main-process RemoteFileProvider AND bundled into
// the renderer through lib/connection.js, so both layers agree on what counts
// as a connection loss instead of maintaining two copies that drift apart.
//
// Keep this module dependency-free: it is imported into the renderer bundle.

const connectionLossConfig = require("../shared/connectionLossConfig.json");

const CONNECTION_LOSS_CODES = new Set(connectionLossConfig.codes);
const CONNECTION_LOSS_MESSAGE = new RegExp(connectionLossConfig.messagePattern);

function isConnectionLossError(error) {
  if (!error) return false;
  const code = String(error.code || "").toUpperCase();
  if (CONNECTION_LOSS_CODES.has(code)) return true;
  return CONNECTION_LOSS_MESSAGE.test(String(error.message || "").toLowerCase());
}

module.exports = {
  CONNECTION_LOSS_CODES,
  CONNECTION_LOSS_MESSAGE,
  isConnectionLossError
};
