"use client";

import { doc, getDoc } from "firebase/firestore";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import Player from "@/components/Player";
import { db, formatDuration } from "@/lib/firebase";

interface Video {
  title: string;
  playlistUrl: string;
  thumbnailUrl: string;
  durationSec: number;
  resolutions?: string[];
}

function Watch() {
  const id = useSearchParams().get("v") ?? "";
  const [video, setVideo] = useState<Video | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    getDoc(doc(db, "videos", id))
      .then((snap) => {
        if (!snap.exists() || snap.get("status") !== "processed") setError("Video not found.");
        else setVideo(snap.data() as Video);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (!id) return <p className="muted">No video selected.</p>;
  if (error) return <p className="muted">{error}</p>;
  if (!video) return <p className="muted">Loading…</p>;

  return (
    <section className="watch">
      <Player videoId={id} src={video.playlistUrl} poster={video.thumbnailUrl} />
      <h1>{video.title}</h1>
      <p className="muted small">
        {formatDuration(video.durationSec)}
        {video.resolutions?.length ? ` · ${video.resolutions.join(" / ")}` : ""}
      </p>
    </section>
  );
}

// useSearchParams needs a Suspense boundary for the static build.
export default function WatchPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <Watch />
    </Suspense>
  );
}
