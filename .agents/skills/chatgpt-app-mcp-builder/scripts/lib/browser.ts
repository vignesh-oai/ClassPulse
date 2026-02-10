import { spawn } from "node:child_process";

export async function openUrlInBrowser(url: string) {
  const command = resolveOpenCommand(url);
  if (!command) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const child = spawn(command.bin, command.args, {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => resolve(false));
    child.unref();
    resolve(true);
  });
}

function resolveOpenCommand(url: string) {
  if (process.platform === "darwin") {
    return { bin: "open", args: [url] };
  }
  if (process.platform === "win32") {
    return { bin: "cmd", args: ["/c", "start", "", url] };
  }
  return { bin: "xdg-open", args: [url] };
}
