import assert from "node:assert/strict";
import { test } from "node:test";

import { pickExtension, rawObjectName } from "../src/validation";

test("extension comes from the file name", () => {
  assert.deepEqual(pickExtension("Beach Day.MOV"), { ext: "mov", contentType: "video/quicktime" });
  assert.deepEqual(pickExtension("clip.mp4", "application/octet-stream"), { ext: "mp4", contentType: "video/mp4" });
});

test("falls back to the MIME type", () => {
  assert.deepEqual(pickExtension("recording", "video/webm"), { ext: "webm", contentType: "video/webm" });
});

test("rejects things that aren't video", () => {
  assert.equal(pickExtension("notes.txt", "text/plain"), null);
  assert.equal(pickExtension(undefined, undefined), null);
  assert.equal(pickExtension("evil.mp4.exe"), null);
});

test("object names are uid-timestamp.ext", () => {
  assert.equal(rawObjectName("abcXYZ09", 1700000000000, "mp4"), "abcXYZ09-1700000000000.mp4");
  assert.throws(() => rawObjectName("../etc", 1, "mp4"));
});
