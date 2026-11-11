import { spawn } from "node:child_process";

const TOOLS: [string, string[]][] = [
  ["wl-copy", []],
  ["xclip", ["-selection", "clipboard"]],
  ["xsel", ["--clipboard", "--input"]],
  ["pbcopy", []],
];

/** Puts `text` on the system clipboard with whichever tool is installed. Returns its name, or null. */
export async function copyToClipboard(text: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  for (const [tool, args] of TOOLS) {
    const worked = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      try {
        const child = spawn(tool, args, { env, stdio: ["pipe", "ignore", "ignore"] });
        child.on("error", () => done(false));
        child.on("exit", (code) => done(code === 0));
        child.stdin.on("error", () => done(false));
        child.stdin.end(text);
        setTimeout(() => done(false), 2500).unref();
      } catch {
        done(false);
      }
    });
    if (worked) return tool;
  }
  return null;
}
