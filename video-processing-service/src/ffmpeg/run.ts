import { spawn } from "node:child_process";

import { PROBE_ARGS, parseProbeOutput, type ProbeResult } from "./probe";

export class FfmpegError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
  }
}

// Runs a binary, collecting stdout; rejects with the tail of stderr on failure.
export function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (err.length > 64_000) err = err.slice(-32_000); // ffmpeg can be chatty
    });
    child.on("error", (e) => reject(new FfmpegError(`${bin} failed to start: ${e.message}`, "")));
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new FfmpegError(`${bin} exited with ${code}`, err.slice(-2000)));
    });
  });
}

export async function probe(file: string, ffprobe = "ffprobe"): Promise<ProbeResult> {
  return parseProbeOutput(await run(ffprobe, [...PROBE_ARGS, file]));
}
