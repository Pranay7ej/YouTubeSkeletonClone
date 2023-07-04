import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import * as functionsV1 from "firebase-functions/v1";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { defineString } from "firebase-functions/params";

import { MAX_TITLE, pickExtension, rawObjectName } from "./validation";

initializeApp();
const db = getFirestore();

const RAW_BUCKET = defineString("RAW_VIDEOS_BUCKET");
const UPLOAD_URL_TTL_MS = 15 * 60 * 1000;

// First sign-in: create the user's profile doc. (Auth "onCreate" triggers only
// exist in the v1 API.)
export const createUser = functionsV1.auth.user().onCreate(async (user) => {
  await db.collection("users").doc(user.uid).set(
    {
      uid: user.uid,
      email: user.email ?? null,
      displayName: user.displayName ?? null,
      photoUrl: user.photoURL ?? null,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
});

// Hands the browser a short-lived signed PUT URL for the raw bucket, so the
// file goes straight to Cloud Storage and never through a server. The video
// doc is created here, in "uploading" state; the processing service picks it
// up when the upload lands.
export const generateUploadUrl = onCall({ maxInstances: 5 }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in to upload.");
  const { fileName, contentType, title } = (req.data ?? {}) as {
    fileName?: string;
    contentType?: string;
    title?: string;
  };
  const ext = pickExtension(fileName, contentType);
  if (!ext) throw new HttpsError("invalid-argument", "Upload an mp4, mov, webm or mkv file.");

  const uid = req.auth.uid;
  const objectName = rawObjectName(uid, Date.now(), ext.ext);
  const videoId = objectName.slice(0, objectName.lastIndexOf("."));

  const [url] = await getStorage()
    .bucket(RAW_BUCKET.value())
    .file(objectName)
    .getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + UPLOAD_URL_TTL_MS,
      contentType: ext.contentType,
    });

  await db
    .collection("videos")
    .doc(videoId)
    .set({
      id: videoId,
      uid,
      title: (title ?? "").trim().slice(0, MAX_TITLE) || "Untitled",
      status: "uploading",
      createdAt: FieldValue.serverTimestamp(),
    });

  return { url, videoId, contentType: ext.contentType };
});

// Newest ready videos first. Needs the (status, createdAt desc) composite index
// from firestore.indexes.json.
export const getVideos = onCall({ maxInstances: 5 }, async (req) => {
  const limit = Math.min(Math.max(Number((req.data as { limit?: number })?.limit ?? 24), 1), 50);
  const snap = await db
    .collection("videos")
    .where("status", "==", "processed")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => {
    const v = d.data();
    return {
      id: d.id,
      uid: v.uid,
      title: v.title,
      thumbnailUrl: v.thumbnailUrl,
      durationSec: v.durationSec,
      createdAt: v.createdAt?.toMillis?.() ?? null,
    };
  });
});
