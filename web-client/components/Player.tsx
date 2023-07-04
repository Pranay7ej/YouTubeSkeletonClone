"use client";

import Hls, { Events, type LevelSwitchedData } from "hls.js";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { useEffect, useRef, useState } from "react";

import { auth, db } from "@/lib/firebase";
import { PlaybackMetrics } from "@/lib/playbackMetrics";

interface Props {
  videoId: string;
  src: string;
  poster?: string;
}

// hls.js everywhere it's supported; Safari plays HLS natively instead.
export default function Player({ videoId, src, poster }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [quality, setQuality] = useState<string>("");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const metrics = new PlaybackMetrics();
    let hls: Hls | null = null;
    let sent = false;

    const on = (name: string, fn: () => void) => video.addEventListener(name, fn);
    on("playing", () => metrics.playing());
    on("waiting", () => metrics.waiting());
    on("seeking", () => metrics.seekStart());
    on("seeked", () => metrics.seekEnd());
    on("timeupdate", () => metrics.timeUpdate(video.currentTime));

    metrics.loadStart();
    if (Hls.isSupported()) {
      hls = new Hls({ capLevelToPlayerSize: true });
      hls.on(Events.LEVEL_SWITCHED, (_e, data: LevelSwitchedData) => {
        const level = hls?.levels[data.level];
        metrics.levelSwitched(data.level, level?.height ?? 0);
        setQuality(level ? `${level.height}p` : "");
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
    }
    video.play().catch(() => {
      // Autoplay blocked; the user will press play.
    });

    // One doc per viewing session, written when the viewer leaves.
    const flush = () => {
      if (sent) return;
      const user = auth.currentUser;
      const s = metrics.snapshot();
      if (!user || s.ttffMs === null) return;
      sent = true;
      addDoc(collection(db, "playbackSessions"), {
        uid: user.uid,
        videoId,
        startedAt: serverTimestamp(),
        ttffMs: s.ttffMs,
        rebufferCount: s.rebufferCount,
        rebufferMs: s.rebufferMs,
        watchedSec: s.watchedSec,
        switches: s.switches,
        userAgent: navigator.userAgent.slice(0, 200),
      }).catch((e) => console.warn("couldn't log playback session", e));
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);

    return () => {
      document.removeEventListener("visibilitychange", onHide);
      flush();
      hls?.destroy();
    };
  }, [src, videoId]);

  return (
    <div className="player">
      <video ref={videoRef} controls playsInline poster={poster} />
      {quality && <span className="quality-badge">{quality}</span>}
    </div>
  );
}
