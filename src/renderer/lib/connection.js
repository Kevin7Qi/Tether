// Tells a dropped/refused connection apart from an ordinary error (missing file,
// conflict, auth, …) so the renderer can recover the session state instead of
// leaving the UI pretending it is connected. The classifier itself lives in a
// shared module that the main process also uses, so both layers agree on what
// counts as a connection loss (it is pure, so bundling it into the renderer is safe).

import connectionLossConfig from "../../shared/connectionLossConfig.json" with { type: "json" };

const CONNECTION_LOSS_CODES = new Set(connectionLossConfig.codes);
const CONNECTION_LOSS_MESSAGE = new RegExp(connectionLossConfig.messagePattern);

export function isConnectionLostError(error) {
  if (!error) return false;
  const code = String(error.code || "").toUpperCase();
  if (CONNECTION_LOSS_CODES.has(code)) return true;
  return CONNECTION_LOSS_MESSAGE.test(String(error.message || "").toLowerCase());
}

export function connectionLostMessage(host) {
  const trimmed = String(host || "").trim();
  return trimmed
    ? `Lost connection to ${trimmed}. Reconnect to continue.`
    : "Lost connection to the remote host. Reconnect to continue.";
}
