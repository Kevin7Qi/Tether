import { spawn } from "node:child_process";
import electronPath from "electron";
import { prepareBackgroundElectron } from "./background-electron.mjs";

const prepared = await prepareBackgroundElectron(electronPath);
let child;

try {
  child = spawn(prepared.executable, process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child?.kill(signal));
  }

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0 || result.signal) {
    console.error(
      `Background Electron exited ${result.signal ? `from ${result.signal}` : `with code ${result.code}`}.`
    );
  }
  process.exitCode = result.code ?? (result.signal ? 1 : 0);
} finally {
  await prepared.cleanup();
}
