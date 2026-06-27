// Tells a dropped/refused connection apart from an ordinary error (missing file,
// conflict, auth, …) so the renderer can recover the session state instead of
// leaving the UI pretending it is connected. The classifier itself lives in a
// shared module that the main process also uses, so both layers agree on what
// counts as a connection loss (it is pure, so bundling it into the renderer is safe).

import { isConnectionLossError } from "../../main/connectionLoss.cjs";

export const isConnectionLostError = isConnectionLossError;

export function connectionLostMessage(host) {
  const trimmed = String(host || "").trim();
  return trimmed
    ? `Lost connection to ${trimmed}. Reconnect to continue.`
    : "Lost connection to the remote host. Reconnect to continue.";
}
