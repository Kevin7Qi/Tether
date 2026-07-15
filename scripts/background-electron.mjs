import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function prepareBackgroundElectron(electronExecutable) {
  if (process.platform !== "darwin") {
    return { executable: electronExecutable, cleanup: async () => {} };
  }

  const sourceBundle = path.resolve(path.dirname(electronExecutable), "../..");
  if (path.extname(sourceBundle) !== ".app") {
    throw new Error(`Could not locate Electron.app from ${electronExecutable}`);
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tether-background-electron-"));
  const backgroundBundle = path.join(tempRoot, "Electron.app");
  const plist = path.join(backgroundBundle, "Contents", "Info.plist");

  try {
    // APFS clone-copy keeps this fast and space-efficient despite Electron's
    // bundled frameworks. LSUIElement must exist before process launch; setting
    // an activation policy from JavaScript is too late to prevent every flash.
    await execFileAsync("/bin/cp", ["-cR", sourceBundle, backgroundBundle]);
    await execFileAsync("/usr/libexec/PlistBuddy", ["-c", "Add :LSUIElement bool true", plist]);
    await execFileAsync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", backgroundBundle]);
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    executable: path.join(backgroundBundle, "Contents", "MacOS", "Electron"),
    cleanup: () => rm(tempRoot, { recursive: true, force: true })
  };
}
