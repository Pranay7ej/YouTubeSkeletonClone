import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import type { ProbeResult } from "../src/ffmpeg/probe";
import { processUpload, videoIdFromFile, type ProcessedInfo, type ProcessorDeps } from "../src/processor";

const PROBE: ProbeResult = {
  width: 1280,
  height: 720,
  durationSec: 30,
  fps: 30,
  videoCodec: "h264",
  audioCodec: "aac",
  rotation: 0,
};

function fakes(opts: { claimed?: boolean; failAt?: "download" | "probe" | "ffmpeg" | "upload" } = {}) {
  const calls: string[] = [];
  const status = new Map<string, string>();
  let processed: ProcessedInfo | null = null;
  let workDir = "";
  const deps: ProcessorDeps = {
    processedBucket: "processed",
    videos: {
      async claim(id) {
        calls.push(`claim ${id}`);
        if (opts.claimed || status.has(id)) return false;
        status.set(id, "processing");
        return true;
      },
      async markProcessed(id, info) {
        status.set(id, "processed");
        processed = info;
      },
      async markFailed(id, reason) {
        calls.push(`failed ${reason}`);
        status.set(id, "failed");
      },
    },
    blobs: {
      async download(bucket, name, dest) {
        calls.push(`download ${bucket}/${name}`);
        workDir = path.dirname(dest);
        if (opts.failAt === "download") throw new Error("404");
        await writeFile(dest, "fake video");
      },
      async uploadDir(dir, bucket, prefix) {
        calls.push(`upload ${bucket}/${prefix}`);
        if (opts.failAt === "upload") throw new Error("permission denied");
        return `https://storage.googleapis.com/${bucket}/${prefix}`;
      },
    },
    media: {
      async probe() {
        if (opts.failAt === "probe") throw new Error("no video stream found");
        return PROBE;
      },
      async ffmpeg(args) {
        calls.push(`ffmpeg ${args.includes("-frames:v") ? "thumbnail" : "hls"}`);
        if (opts.failAt === "ffmpeg") throw new Error("ffmpeg exited with 1");
      },
    },
  };
  return { deps, calls, status, getProcessed: () => processed, getWorkDir: () => workDir };
}

test("video id is the file name without extension", () => {
  assert.equal(videoIdFromFile("abc123-1700000000000.mp4"), "abc123-1700000000000");
  assert.equal(videoIdFromFile("folder/x.y.mov"), "x.y");
  assert.equal(videoIdFromFile("noext"), "noext");
});

test("happy path: claim, download, transcode, thumbnail, upload, mark processed", async () => {
  const f = fakes();
  const out = await processUpload("raw", "u1-1.mp4", f.deps);
  assert.equal(out.status, "processed");
  assert.deepEqual(f.calls, ["claim u1-1", "download raw/u1-1.mp4", "ffmpeg hls", "ffmpeg thumbnail", "upload processed/u1-1"]);
  assert.equal(f.status.get("u1-1"), "processed");
  assert.deepEqual(f.getProcessed(), {
    durationSec: 30,
    playlistUrl: "https://storage.googleapis.com/processed/u1-1/master.m3u8",
    thumbnailUrl: "https://storage.googleapis.com/processed/u1-1/thumbnail.jpg",
    resolutions: ["360p", "720p"],
  });
  assert.equal(existsSync(f.getWorkDir()), false, "temp dir should be cleaned up");
});

test("duplicate Pub/Sub delivery is skipped without touching anything", async () => {
  const f = fakes({ claimed: true });
  const out = await processUpload("raw", "u1-1.mp4", f.deps);
  assert.equal(out.status, "duplicate");
  assert.deepEqual(f.calls, ["claim u1-1"]);
});

test("second delivery after a successful run is a duplicate", async () => {
  const f = fakes();
  await processUpload("raw", "u1-1.mp4", f.deps);
  const again = await processUpload("raw", "u1-1.mp4", f.deps);
  assert.equal(again.status, "duplicate");
});

for (const step of ["download", "probe", "ffmpeg", "upload"] as const) {
  test(`failure during ${step} marks the video failed and cleans up`, async () => {
    const f = fakes({ failAt: step });
    const out = await processUpload("raw", "u2-2.mp4", f.deps);
    assert.equal(out.status, "failed");
    assert.equal(f.status.get("u2-2"), "failed");
    assert.ok(f.calls.some((c) => c.startsWith("failed ")));
    if (f.getWorkDir()) assert.equal(existsSync(f.getWorkDir()), false);
  });
}
