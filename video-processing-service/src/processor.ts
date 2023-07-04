// The whole job for one uploaded file. Storage, Firestore and ffmpeg are
// passed in, so tests can swap in fakes and check the control flow (duplicate
// deliveries, failures, cleanup) without any cloud services.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildHlsArgs, buildThumbnailArgs, type Rendition } from "./ffmpeg/args";
import type { ProbeResult } from "./ffmpeg/probe";

export type VideoStatus = "uploading" | "processing" | "processed" | "failed";

export interface ProcessedInfo {
  durationSec: number;
  playlistUrl: string;
  thumbnailUrl: string;
  resolutions: string[];
}

export interface VideoStore {
  // Atomically moves the video to "processing". Returns false if someone else
  // already has it (Pub/Sub delivers at least once, so duplicates happen).
  claim(videoId: string, rawFile: string): Promise<boolean>;
  markProcessed(videoId: string, info: ProcessedInfo): Promise<void>;
  markFailed(videoId: string, reason: string): Promise<void>;
}

export interface BlobStore {
  download(bucket: string, name: string, dest: string): Promise<void>;
  // Uploads every file under dir to bucket/prefix/. Returns the public base URL.
  uploadDir(dir: string, bucket: string, prefix: string): Promise<string>;
}

export interface MediaTools {
  probe(file: string): Promise<ProbeResult>;
  ffmpeg(args: string[]): Promise<unknown>;
}

export interface ProcessorDeps {
  videos: VideoStore;
  blobs: BlobStore;
  media: MediaTools;
  processedBucket: string;
  workRoot?: string;
  log?: (msg: string) => void;
}

export type Outcome =
  | { status: "processed"; videoId: string; renditions: Rendition[] }
  | { status: "duplicate"; videoId: string }
  | { status: "failed"; videoId: string; error: string };

// Raw uploads are named "<uid>-<timestamp>.<ext>"; the id is the name minus the extension.
export function videoIdFromFile(name: string): string {
  const base = path.basename(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export async function processUpload(bucket: string, name: string, deps: ProcessorDeps): Promise<Outcome> {
  const log = deps.log ?? (() => {});
  const videoId = videoIdFromFile(name);

  if (!(await deps.videos.claim(videoId, name))) {
    log(`${videoId}: already claimed, skipping duplicate delivery`);
    return { status: "duplicate", videoId };
  }

  const work = await mkdtemp(path.join(deps.workRoot ?? tmpdir(), `vps-${videoId}-`));
  try {
    const input = path.join(work, path.basename(name));
    const outDir = path.join(work, "out");
    await mkdir(outDir, { recursive: true });

    log(`${videoId}: downloading gs://${bucket}/${name}`);
    await deps.blobs.download(bucket, name, input);

    const probe = await deps.media.probe(input);
    log(`${videoId}: ${probe.width}x${probe.height} ${probe.fps.toFixed(2)}fps ${probe.durationSec.toFixed(1)}s`);

    const cmd = buildHlsArgs(input, outDir, probe);
    log(`${videoId}: transcoding to ${cmd.renditions.map((r) => r.name).join(", ")}`);
    await deps.media.ffmpeg(cmd.args);
    await deps.media.ffmpeg(buildThumbnailArgs(input, path.join(outDir, "thumbnail.jpg"), probe.durationSec));

    const base = await deps.blobs.uploadDir(outDir, deps.processedBucket, videoId);
    await deps.videos.markProcessed(videoId, {
      durationSec: probe.durationSec,
      playlistUrl: `${base}/master.m3u8`,
      thumbnailUrl: `${base}/thumbnail.jpg`,
      resolutions: cmd.renditions.map((r) => r.name),
    });
    log(`${videoId}: done`);
    return { status: "processed", videoId, renditions: cmd.renditions };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`${videoId}: failed: ${error}`);
    try {
      await deps.videos.markFailed(videoId, error);
    } catch (inner) {
      log(`${videoId}: couldn't record failure: ${String(inner)}`);
    }
    return { status: "failed", videoId, error };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
