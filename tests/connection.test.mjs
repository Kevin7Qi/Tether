import test from "node:test";
import assert from "node:assert/strict";
import { isConnectionLostError, connectionLostMessage } from "../src/renderer/lib/connection.js";

test("isConnectionLostError matches connection-loss error codes", () => {
  for (const code of ["CONNECTION_LOST", "NOT_CONNECTED", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]) {
    assert.equal(isConnectionLostError({ code }), true, code);
  }
});

test("isConnectionLostError matches connection-loss messages without a code", () => {
  assert.equal(isConnectionLostError({ message: "read ECONNRESET" }), true);
  assert.equal(isConnectionLostError({ message: "No SFTP connection available" }), true);
  assert.equal(isConnectionLostError({ message: "Connection lost before the response arrived" }), true);
  assert.equal(isConnectionLostError({ message: "Socket hang up" }), true);
  assert.equal(isConnectionLostError({ message: "Keepalive timeout" }), true);
});

test("isConnectionLostError does NOT flag ordinary remote errors", () => {
  assert.equal(isConnectionLostError({ code: "REMOTE_CONFLICT", message: "The remote file changed after you opened it." }), false);
  assert.equal(isConnectionLostError({ code: "AUTH_FAILED", message: "Authentication failed for deploy@host." }), false);
  assert.equal(isConnectionLostError({ code: "HOST_KEY_MISMATCH", message: "The SSH host key changed." }), false);
  assert.equal(isConnectionLostError({ code: "ENOENT", message: "No such file or directory" }), false);
  assert.equal(isConnectionLostError(null), false);
  assert.equal(isConnectionLostError(undefined), false);
  assert.equal(isConnectionLostError({}), false);
});

test("connectionLostMessage includes the host when known", () => {
  assert.equal(connectionLostMessage("edge-03"), "Lost connection to edge-03. Reconnect to continue.");
  assert.equal(connectionLostMessage(""), "Lost connection to the remote host. Reconnect to continue.");
  assert.equal(connectionLostMessage(), "Lost connection to the remote host. Reconnect to continue.");
});
