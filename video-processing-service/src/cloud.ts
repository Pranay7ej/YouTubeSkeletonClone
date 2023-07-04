// Cloud adapters for the processor: GCS for files, Firestore for status.
import { readdir } from "node:fs/promises";
import path from "node:path";

import { Storage } from "@google-cloud/storage";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

import type { BlobStore, ProcessedInfo, VideoStore } from "./processor";

initializeApp();
const db = getFirestore();
const storage = new Storage();

const CONTENT_TYPES: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
};

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

export const gcsBlobStore: BlobStore = {
  async download(bucket, name, dest) {
    await storage.bucket(bucket).file(name).download({ destination: dest });
  },
  async uploadDir(dir, bucket, prefix) {
    const files = await walk(dir);
    // A few at a time: a 10 minute video is ~450 segments.
    const queue = [...files];
    const workers = Array.from({ length: 8 }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const rel = path.relative(dir, f).split(path.sep).join("/");
        const ext = path.extname(f);
        await storage.bucket(bucket).upload(f, {
          destination: `${prefix}/${rel}`,
          contentType: CONTENT_TYPES[ext],
          metadata: {
            // Playlists are tiny and fine to cache briefly; segments never change.
            cacheControl: ext === ".m3u8" ? "public, max-age=60" : "public, max-age=31536000, immutable",
          },
        });
      }
    });
    await Promise.all(workers);
    return `https://storage.googleapis.com/${bucket}/${prefix}`;
  },
};

const videos = db.collection("videos");

export const firestoreVideoStore: VideoStore = {
  async claim(videoId, rawFile) {
    const ref = videos.doc(videoId);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const status = snap.exists ? (snap.get("status") as string | undefined) : undefined;
      if (status && status !== "uploading") return false;
      tx.set(
        ref,
        { status: "processing", rawFile, processingStartedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return true;
    });
  },
  async markProcessed(videoId, info: ProcessedInfo) {
    await videos.doc(videoId).set(
      { status: "processed", ...info, processedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  },
  async markFailed(videoId, reason) {
    await videos.doc(videoId).set(
      { status: "failed", error: reason.slice(0, 500), failedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  },
};
