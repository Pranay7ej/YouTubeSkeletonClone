// Cloud Run entry point. The raw-videos bucket publishes an OBJECT_FINALIZE
// notification to Pub/Sub, and a push subscription POSTs it here.
import express from "express";

import { firestoreVideoStore, gcsBlobStore } from "./cloud";
import { probe, run } from "./ffmpeg/run";
import { processUpload } from "./processor";

const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET ?? "";
const PORT = Number(process.env.PORT ?? 8080);

if (!PROCESSED_BUCKET) {
  console.error("PROCESSED_BUCKET is not set");
  process.exit(1);
}

interface PushBody {
  message?: { data?: string; attributes?: Record<string, string> };
}

// GCS notifications carry the object metadata as base64 JSON in message.data.
function parseNotification(body: PushBody): { bucket: string; name: string } | null {
  const data = body.message?.data;
  if (!data) return null;
  try {
    const obj = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as { bucket?: string; name?: string };
    if (!obj.bucket || !obj.name) return null;
    return { bucket: obj.bucket, name: obj.name };
  } catch {
    return null;
  }
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.send("ok");
});

app.post("/process-video", async (req, res) => {
  const note = parseNotification(req.body as PushBody);
  if (!note) {
    // Acknowledge garbage so Pub/Sub doesn't redeliver it forever.
    res.status(200).send("ignored: not a storage notification");
    return;
  }
  const outcome = await processUpload(note.bucket, note.name, {
    videos: firestoreVideoStore,
    blobs: gcsBlobStore,
    media: { probe: (f) => probe(f), ffmpeg: (args) => run("ffmpeg", args) },
    processedBucket: PROCESSED_BUCKET,
    log: (m) => console.log(m),
  });
  // Failures are recorded on the video doc; acking avoids a retry loop on a
  // file that will never transcode.
  res.status(200).json(outcome);
});

app.listen(PORT, () => {
  console.log(`video-processing-service listening on ${PORT}`);
});
