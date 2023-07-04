// Runs the real ffmpeg on a short generated clip and checks what comes out.
// Skipped when ffmpeg isn't installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { buildHlsArgs, buildThumbnailArgs } from "../src/ffmpeg/args";
import { probe, run } from "../src/ffmpeg/run";

const haveFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vps-it-"));
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("transcodes a 9 s 720p clip into a 2-rung HLS ladder", { skip: !haveFfmpeg && "ffmpeg not installed" }, async () => {
  const input = path.join(dir, "clip.mp4");
  // 29.97 fps source, like a phone, with a tone for audio.
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30000/1001",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "9", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", input,
  ]);

  const p = await probe(input);
  assert.deepEqual([p.width, p.height], [1280, 720]);
  assert.ok(Math.abs(p.durationSec - 9) < 0.2);

  const out = path.join(dir, "out");
  const cmd = buildHlsArgs(input, out, p);
  await run("ffmpeg", ["-loglevel", "error", ...cmd.args]);
  await run("ffmpeg", ["-loglevel", "error", ...buildThumbnailArgs(input, path.join(out, "thumbnail.jpg"), p.durationSec)]);

  const master = await readFile(path.join(out, "master.m3u8"), "utf8");
  const variants = master.split("\n").filter((l) => l.startsWith("#EXT-X-STREAM-INF"));
  assert.equal(variants.length, 2, master);
  assert.match(master, /RESOLUTION=640x360/);
  assert.match(master, /RESOLUTION=1280x720/);
  assert.doesNotMatch(master, /1920x1080/); // no upscaling

  for (const v of ["v0", "v1"]) {
    const media = await readFile(path.join(out, v, "index.m3u8"), "utf8");
    assert.match(media, /#EXT-X-MAP:URI="init_\d\.mp4"/);
    assert.match(media, /#EXT-X-ENDLIST/);
    const durations = [...media.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
    // 9 s in 4 s segments: 4, 4, 1.
    assert.equal(durations.length, 3, media);
    assert.ok(Math.abs(durations[0] - 4) < 0.05 && Math.abs(durations[1] - 4) < 0.05, media);
    const files = await readdir(path.join(out, v));
    assert.equal(files.filter((f) => f.endsWith(".m4s")).length, 3);
  }

  // Output is constant 30 fps with a keyframe exactly every 2 s. The init
  // segment alone has no frames, so probe init + segments joined together.
  const v1 = path.join(out, "v1");
  const joined = Buffer.concat([
    await readFile(path.join(v1, "init_1.mp4")),
    ...(await Promise.all(["seg_000.m4s", "seg_001.m4s", "seg_002.m4s"].map((s) => readFile(path.join(v1, s))))),
  ]);
  const probeRun = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time,key_frame", "-of", "csv=p=0", "-"],
    { input: joined },
  );
  const rows = probeRun.stdout.toString().trim().split("\n").map((l) => l.split(",").map(Number));
  const keyTimes = rows.filter(([key]) => key === 1).map(([, t]) => t);
  const t0 = keyTimes[0];
  assert.deepEqual(keyTimes.map((t) => Math.round((t - t0) * 10) / 10), [0, 2, 4, 6, 8]);
  const frameCount = rows.length;
  assert.ok(Math.abs(frameCount - 270) <= 2, `expected ~270 frames at 30 fps, got ${frameCount}`);

  const thumb = await readFile(path.join(out, "thumbnail.jpg"));
  assert.equal(thumb[0], 0xff); // JPEG magic
  assert.equal(thumb[1], 0xd8);
});
