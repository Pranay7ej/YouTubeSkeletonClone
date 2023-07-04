"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { formatDuration, getVideos, type VideoSummary } from "@/lib/firebase";

export default function Home() {
  const [videos, setVideos] = useState<VideoSummary[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getVideos()
      .then(setVideos)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <p className="muted">Couldn&apos;t load videos: {error}</p>;
  if (!videos) return <p className="muted">Loading…</p>;
  if (videos.length === 0) return <p className="muted">Nothing here yet. Sign in and upload something.</p>;

  return (
    <div className="grid">
      {videos.map((v) => (
        <Link key={v.id} href={`/watch?v=${encodeURIComponent(v.id)}`} className="card">
          <div className="thumb">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={v.thumbnailUrl} alt="" loading="lazy" />
            <span className="duration">{formatDuration(v.durationSec)}</span>
          </div>
          <div className="title">{v.title}</div>
          {v.createdAt && <div className="muted small">{new Date(v.createdAt).toLocaleDateString()}</div>}
        </Link>
      ))}
    </div>
  );
}
