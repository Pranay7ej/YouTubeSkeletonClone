import assert from "node:assert/strict";
import { test } from "node:test";

import { buildHlsArgs, buildThumbnailArgs, planRenditions, targetFps } from "../src/ffmpeg/args";
import type { ProbeResult } from "../src/ffmpeg/probe";

const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  width: 1920,
  height: 1080,
  durationSec: 60,
  fps: 30,
  videoCodec: "h264",
  audioCodec: "aac",
  rotation: 0,
  ...over,
});

const names = (p: ProbeResult) => planRenditions(p).map((r) => r.name);

test("1080p source gets the full ladder", () => {
  assert.deepEqual(names(probe()), ["360p", "720p", "1080p"]);
  const r = planRenditions(probe());
  assert.deepEqual([r[1].width, r[1].height], [1280, 720]);
  assert.deepEqual([r[0].width, r[0].height], [640, 360]);
});

test("never upscales", () => {
  assert.deepEqual(names(probe({ width: 1280, height: 720 })), ["360p", "720p"]);
  assert.deepEqual(names(probe({ width: 854, height: 480 })), ["360p"]);
  assert.deepEqual(names(probe({ width: 3840, height: 2160 })), ["360p", "720p", "1080p"]);
});

test("a few pixels short still counts as the rung", () => {
  assert.deepEqual(names(probe({ width: 1280, height: 718 })), ["360p", "720p"]);
  const r = planRenditions(probe({ width: 1280, height: 718 }));
  assert.equal(r[1].height, 718); // but it's not stretched to 720
});

test("tiny source gets a single rendition at its own size", () => {
  const r = planRenditions(probe({ width: 320, height: 240 }));
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].width, r[0].height], [320, 240]);
  assert.equal(r[0].name, "240p");
  assert.ok(r[0].videoKbps < 800 && r[0].videoKbps >= 200);
});

test("portrait video uses the short side", () => {
  const r = planRenditions(probe({ width: 1080, height: 1920 }));
  assert.deepEqual(r.map((x) => [x.width, x.height]), [
    [360, 640],
    [720, 1280],
    [1080, 1920],
  ]);
});

test("odd aspect ratios round to even dimensions", () => {
  for (const x of planRenditions(probe({ width: 1998, height: 1080 }))) {
    assert.equal(x.width % 2, 0);
    assert.equal(x.height % 2, 0);
  }
});

test("frame rate snaps to a standard constant rate", () => {
  assert.equal(targetFps(29.97), 30);
  assert.equal(targetFps(29.87), 30); // VFR phone average
  assert.equal(targetFps(23.976), 24);
  assert.equal(targetFps(59.94), 60);
  assert.equal(targetFps(120), 60);
  assert.equal(targetFps(25), 25);
});

const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test("keyframes land every 2 s and scene cuts don't add extra ones", () => {
  const { args, fps } = buildHlsArgs("in.mp4", "/out", probe({ fps: 29.97 }));
  assert.equal(fps, 30);
  assert.equal(valueAfter(args, "-force_key_frames"), "expr:gte(t,n_forced*2)");
  assert.equal(valueAfter(args, "-g"), "60");
  assert.equal(valueAfter(args, "-keyint_min"), "60");
  assert.equal(valueAfter(args, "-sc_threshold"), "0");
  assert.equal(valueAfter(args, "-fps_mode"), "cfr");
  assert.match(valueAfter(args, "-filter_complex"), /^\[0:v\]fps=30,split=3/);
});

test("per-rendition bitrates with maxrate and bufsize", () => {
  const { args } = buildHlsArgs("in.mp4", "/out", probe());
  assert.equal(valueAfter(args, "-b:v:0"), "800k");
  assert.equal(valueAfter(args, "-b:v:2"), "5000k");
  assert.equal(valueAfter(args, "-maxrate:v:1"), "2996k");
  assert.equal(valueAfter(args, "-bufsize:v:1"), "4200k");
  assert.equal(valueAfter(args, "-b:a:0"), "96k");
});

test("HLS output: 4 s fMP4 segments, one playlist per rendition", () => {
  const { args } = buildHlsArgs("in.mp4", "/out", probe());
  assert.equal(valueAfter(args, "-hls_time"), "4");
  assert.equal(valueAfter(args, "-hls_segment_type"), "fmp4");
  assert.equal(valueAfter(args, "-var_stream_map"), "v:0,a:0 v:1,a:1 v:2,a:2");
  assert.equal(args[args.length - 1], "/out/v%v/index.m3u8");
  assert.equal(args.filter((a) => a === "-map").length, 6);
});

test("silent video maps no audio", () => {
  const { args } = buildHlsArgs("in.mp4", "/out", probe({ audioCodec: null, width: 1280, height: 720 }));
  assert.equal(valueAfter(args, "-var_stream_map"), "v:0 v:1");
  assert.ok(!args.includes("0:a:0"));
  assert.ok(!args.includes("-c:a"));
});

test("audio is resampled against timestamps (no drift)", () => {
  const { args } = buildHlsArgs("in.mp4", "/out", probe());
  assert.equal(valueAfter(args, "-af"), "aresample=async=1:first_pts=0");
  assert.equal(valueAfter(args, "-ar"), "48000");
});

test("thumbnail is taken 10% in", () => {
  const args = buildThumbnailArgs("in.mp4", "t.jpg", 125);
  assert.equal(valueAfter(args, "-ss"), "12.500");
  assert.ok(args.indexOf("-ss") < args.indexOf("-i")); // fast seek
  assert.equal(valueAfter(args, "-frames:v"), "1");
});
