// Classifies remote-operation failures so the renderer can tell a dropped/refused
// connection apart from an ordinary error (missing file, conflict, auth, …) and
// recover the session state instead of leaving the UI pretending it is connected.

const CONNECTION_LOST_CODES = new Set([
  "CONNECTION_LOST",
  "NOT_CONNECTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "ENOTCONN"
]);

const CONNECTION_LOST_MESSAGE =
  /\b(econnreset|econnrefused|econnaborted|etimedout|ehostunreach|enetunreach|epipe|enotconn)\b|not connected|no sftp connection|sftp.*\b(closed|ended|disconnect)|connection (lost|closed|reset|ended|aborted|timed out|refused)|socket (closed|hang ?up)|channel open failure|server unexpectedly closed|keepalive timeout/;

export function isConnectionLostError(error) {
  if (!error) return false;
  const code = String(error.code || "").toUpperCase();
  if (CONNECTION_LOST_CODES.has(code)) return true;
  return CONNECTION_LOST_MESSAGE.test(String(error.message || "").toLowerCase());
}

export function connectionLostMessage(host) {
  const trimmed = String(host || "").trim();
  return trimmed
    ? `Lost connection to ${trimmed}. Reconnect to continue.`
    : "Lost connection to the remote host. Reconnect to continue.";
}
