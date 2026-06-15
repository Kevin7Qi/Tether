import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = process.env.REMOTE_MD_PORT || "3000";
const devServerUrl = `http://127.0.0.1:${port}`;
const viteBin = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
const electronCli = path.join(projectRoot, "node_modules", "electron", "cli.js");

const vite = spawn(
  process.execPath,
  [viteBin, "--host", "127.0.0.1", "--port", port, "--clearScreen", "false"],
  {
    cwd: projectRoot,
    stdio: ["inherit", "pipe", "inherit"],
    shell: false
  }
);

let electron;
let started = false;

function startElectron() {
  if (started) return;
  started = true;
  electron = spawn(process.execPath, [electronCli, "."], {
    cwd: projectRoot,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: devServerUrl
    }
  });

  electron.on("exit", (code) => {
    vite.kill();
    process.exit(code ?? 0);
  });
}

vite.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (text.includes(devServerUrl)) {
    startElectron();
  }
});

vite.on("exit", (code) => {
  if (!started) process.exit(code ?? 1);
});

setTimeout(startElectron, 1800);

process.on("SIGINT", () => {
  electron?.kill();
  vite.kill();
  process.exit(0);
});
