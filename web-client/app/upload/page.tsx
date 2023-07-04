"use client";

import { onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import Link from "next/link";
import { useEffect, useState } from "react";

import { auth, db, requestUpload, uploadToSignedUrl, type User } from "@/lib/firebase";

type Phase = "idle" | "uploading" | "processing" | "done" | "failed";

export default function UploadPage() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [videoId, setVideoId] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  // After the upload, follow the video doc until the processing service is done.
  useEffect(() => {
    if (!videoId) return;
    return onSnapshot(doc(db, "videos", videoId), (snap) => {
      const status = snap.get("status") as string | undefined;
      if (status === "processed") setPhase("done");
      if (status === "failed") {
        setPhase("failed");
        setMessage(snap.get("error") ?? "processing failed");
      }
    });
  }, [videoId]);

  if (user === undefined) return null;
  if (!user) return <p className="muted">Sign in to upload.</p>;

  const start = async () => {
    if (!file) return;
    setMessage("");
    setPhase("uploading");
    try {
      const ticket = await requestUpload(file, title || file.name.replace(/\.[^.]+$/, ""));
      await uploadToSignedUrl(ticket, file, setProgress);
      setVideoId(ticket.videoId);
      setPhase("processing");
    } catch (e) {
      setPhase("failed");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="upload">
      <h1>Upload</h1>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder="My video" />
      </label>
      <label>
        File
        <input type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <button className="button" disabled={!file || phase === "uploading" || phase === "processing"} onClick={start}>
        Upload
      </button>

      {phase === "uploading" && (
        <div className="progress">
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {phase === "processing" && <p className="muted">Uploaded. Transcoding into 360p / 720p / 1080p…</p>}
      {phase === "done" && (
        <p>
          Ready. <Link href={`/watch?v=${encodeURIComponent(videoId)}`}>Watch it</Link>
        </p>
      )}
      {phase === "failed" && <p className="error">{message}</p>}
    </section>
  );
}
