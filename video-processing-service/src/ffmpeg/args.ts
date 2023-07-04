// Which qualities to produce for an upload, and the ffmpeg command that makes
// them. Pure functions so they're easy to test; running ffmpeg lives in run.ts.
import type { ProbeResult } from "./probe";

export interface Rung {
  name: string; // "720p"
  shortSide: number; // 720 means 1280x720 landscape or 720x1280 portrait
  videoKbps: number;
  audioKbps: number;
}

export const LADDER: Rung[] = [
  { name: "360p", shortSide: 360, videoKbps: 800, audioKbps: 96 },
  { name: "720p", shortSide: 720, videoKbps: 2800, audioKbps: 128 },
  { name: "1080p", shortSide: 1080, videoKbps: 5000, audioKbps: 128 },
];

export const SEGMENT_SECONDS = 4;
export const KEYFRAME_SECONDS = 2;

export interface Rendition extends Rung {
  width: number;
  height: number;
}

const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));

// Standard output rates. Phone clips are often variable frame rate (29.87,
// 30.02, ...); snapping to a constant rate is what keeps audio from drifting.
export function targetFps(sourceFps: number): number {
  const standard = [24, 25, 30, 50, 60];
  let best = 30;
  for (const r of standard) {
    if (Math.abs(r - sourceFps) < Math.abs(best - sourceFps)) best = r;
  }
  return Math.min(best, 60);
}

// Every rung whose short side fits in the source, never upscaling. A source
// smaller than the lowest rung gets one rendition at its own size.
export function planRenditions(probe: ProbeResult): Rendition[] {
  const portrait = probe.height > probe.width;
  const srcShort = Math.min(probe.width, probe.height);
  const aspect = Math.max(probe.width, probe.height) / srcShort;

  const make = (rung: Rung, short: number): Rendition => {
    const long = even(short * aspect);
    const s = even(short);
    return { ...rung, width: portrait ? s : long, height: portrait ? long : s };
  };

  // Allow a few pixels of slack: 1280x718 should still count as 720p.
  const fits = LADDER.filter((r) => r.shortSide <= srcShort + 8);
  if (fits.length === 0) {
    const low = LADDER[0];
    const kbps = Math.max(200, Math.round((low.videoKbps * srcShort) / low.shortSide));
    return [make({ ...low, name: `${even(srcShort)}p`, videoKbps: kbps, shortSide: srcShort }, srcShort)];
  }
  return fits.map((r) => make(r, Math.min(r.shortSide, srcShort)));
}

export interface HlsCommand {
  args: string[];
  renditions: Rendition[];
  fps: number;
}

// One ffmpeg run that decodes once and writes every rendition:
//   out/master.m3u8, out/v0/index.m3u8, out/v0/init.mp4, out/v0/seg_000.m4s, ...
export function buildHlsArgs(input: string, outDir: string, probe: ProbeResult): HlsCommand {
  const renditions = planRenditions(probe);
  const fps = targetFps(probe.fps);
  const hasAudio = probe.audioCodec !== null;
  const n = renditions.length;
  const portrait = probe.height > probe.width;

  const splits = renditions.map((_, i) => `[s${i}]`).join("");
  const scales = renditions
    .map((r, i) => {
      const scale = portrait ? `scale=${r.width}:-2` : `scale=-2:${r.height}`;
      return `[s${i}]${scale},setsar=1[v${i}]`;
    })
    .join(";");
  // fps first so every rendition gets the same constant-rate frames.
  const filter = `[0:v]fps=${fps},split=${n}${splits};${scales}`;

  const args: string[] = ["-hide_banner", "-y", "-i", input, "-filter_complex", filter];

  renditions.forEach((_, i) => {
    args.push("-map", `[v${i}]`);
    if (hasAudio) args.push("-map", "0:a:0");
  });

  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    // Keyframes on a fixed 2 s grid in every rendition, so the player can
    // switch quality at any segment boundary.
    "-force_key_frames", `expr:gte(t,n_forced*${KEYFRAME_SECONDS})`,
    "-g", String(fps * KEYFRAME_SECONDS),
    "-keyint_min", String(fps * KEYFRAME_SECONDS),
    "-sc_threshold", "0",
    "-fps_mode", "cfr",
  );

  renditions.forEach((r, i) => {
    args.push(
      `-b:v:${i}`, `${r.videoKbps}k`,
      `-maxrate:v:${i}`, `${Math.round(r.videoKbps * 1.07)}k`,
      `-bufsize:v:${i}`, `${Math.round(r.videoKbps * 1.5)}k`,
    );
    if (hasAudio) args.push(`-b:a:${i}`, `${r.audioKbps}k`);
  });

  if (hasAudio) {
    // Resample against timestamps so audio stays locked to the CFR video.
    args.push("-c:a", "aac", "-ar", "48000", "-ac", "2", "-af", "aresample=async=1:first_pts=0");
  }

  const streamMap = renditions.map((_, i) => (hasAudio ? `v:${i},a:${i}` : `v:${i}`)).join(" ");
  args.push(
    "-f", "hls",
    "-hls_time", String(SEGMENT_SECONDS),
    "-hls_playlist_type", "vod",
    "-hls_segment_type", "fmp4",
    "-hls_flags", "independent_segments",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", `${outDir}/v%v/seg_%03d.m4s`,
    "-master_pl_name", "master.m3u8",
    "-var_stream_map", streamMap,
    `${outDir}/v%v/index.m3u8`,
  );

  return { args, renditions, fps };
}

// Grab one frame 10% into the video (fast seek before -i).
export function buildThumbnailArgs(input: string, output: string, durationSec: number): string[] {
  const at = Math.max(0, durationSec * 0.1).toFixed(3);
  return ["-hide_banner", "-y", "-ss", at, "-i", input, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3", output];
}
