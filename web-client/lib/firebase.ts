import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, type User } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const app = getApps().length ? getApp() : initializeApp(config);
export const auth = getAuth(app);
export const db = getFirestore(app);
const functions = getFunctions(app, process.env.NEXT_PUBLIC_FUNCTIONS_REGION ?? "us-central1");

export const signInWithGoogle = () => signInWithPopup(auth, new GoogleAuthProvider());
export const signOutUser = () => signOut(auth);
export type { User };

export interface VideoSummary {
  id: string;
  uid: string;
  title: string;
  thumbnailUrl: string;
  durationSec: number;
  createdAt: number | null;
}

export interface UploadTicket {
  url: string;
  videoId: string;
  contentType: string;
}

const getVideosFn = httpsCallable<{ limit?: number }, VideoSummary[]>(functions, "getVideos");
const generateUploadUrlFn = httpsCallable<
  { fileName: string; contentType: string; title: string },
  UploadTicket
>(functions, "generateUploadUrl");

export async function getVideos(limit = 24): Promise<VideoSummary[]> {
  return (await getVideosFn({ limit })).data;
}

export async function requestUpload(file: File, title: string): Promise<UploadTicket> {
  return (await generateUploadUrlFn({ fileName: file.name, contentType: file.type, title })).data;
}

// PUT straight to the signed URL. XHR instead of fetch because fetch still
// can't report upload progress.
export function uploadToSignedUrl(
  ticket: UploadTicket,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", ticket.url);
    xhr.setRequestHeader("Content-Type", ticket.contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`upload failed: ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("upload failed: network error"));
    xhr.send(file);
  });
}

export function formatDuration(sec: number | undefined): string {
  if (!sec || !Number.isFinite(sec)) return "";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
