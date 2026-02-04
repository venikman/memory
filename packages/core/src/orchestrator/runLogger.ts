import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunResult } from "./types.js";

export type RunLoggerOptions = {
  runsDir: string;
};

export class RunLogger {
  private readonly runsDir: string;

  public constructor(opts: RunLoggerOptions) {
    this.runsDir = opts.runsDir;
  }

  public log(run: RunResult): string {
    mkdirSync(this.runsDir, { recursive: true });
    const day = run.createdAt.slice(0, 10).replaceAll("-", "");
    const file = join(this.runsDir, `runs-${day}.jsonl`);
    appendFileSync(file, JSON.stringify(run) + "\n", "utf8");
    return file;
  }
}

