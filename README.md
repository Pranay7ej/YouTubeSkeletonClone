# YouTubeSkeletonClone

A bare-bones YouTube: sign in with Google, upload a video, and it comes back as
an adaptive stream (360p / 720p / 1080p) that plays with hls.js. No comments, no
recommendations, no likes. Just the upload → transcode → stream pipeline, which
is the part I actually wanted to understand.

**Stack:** TypeScript, Next.js, Firebase (Auth, Firestore, Cloud Functions),
Cloud Storage, Pub/Sub, Docker on Cloud Run, FFmpeg.

## How it fits together

```
 browser ── sign in (Firebase Auth) ──► createUser fn ──► users/{uid}
    │
    ├── generateUploadUrl fn ──► videos/{id} = "uploading", returns signed PUT URL
    │
    └── PUT file ───────────────► raw-videos bucket
                                        │ OBJECT_FINALIZE
                                        ▼
                                     Pub/Sub ──push──► video-processing-service (Cloud Run)
                                                          claim → download → ffprobe
                                                          → ffmpeg HLS ladder + thumbnail
                                                          → upload to processed bucket
                                                          → videos/{id} = "processed"
 browser ◄── getVideos fn (newest first)
    └── /watch ── hls.js ◄── master.m3u8 + segments from the processed bucket
             └── playback metrics ──► playbackSessions
```

### web-client (Next.js)

- Google sign-in through Firebase Auth.
- `/` home feed, newest first, from `getVideos`.
- `/upload` asks for a signed URL, `PUT`s the file straight to Cloud Storage
  (with a progress bar), then watches the video doc until it's processed.
- `/watch?v=<id>` plays the HLS stream with hls.js (native HLS on Safari).
- The watch page records time to first frame, rebuffer count and duration, and
  every quality switch from hls.js events, and writes one
  `playbackSessions` doc when you leave the page. That logic lives in
  `lib/playbackMetrics.ts` with no DOM dependencies so it can be unit tested.

### api-service (Cloud Functions)

- `generateUploadUrl` checks the file type, names the object
  `<uid>-<millis>.<ext>`, creates the video doc in `uploading` state and returns
  a v4 signed URL that's good for 15 minutes. The file never passes through
  a server.
- `getVideos` lists processed videos, newest first.
- `createUser` fires on first sign-in and creates the user doc.

### video-processing-service (Cloud Run)

The interesting part. For each upload:

1. **Claim the video** in a Firestore transaction (`uploading` → `processing`).
   Pub/Sub delivers at least once, so the same message can show up twice; if
   the doc is already past `uploading`, the second delivery is skipped.
2. Download the raw file and run **ffprobe** for resolution, duration, frame
   rate, codecs and rotation (phone videos are stored landscape with a rotation
   flag, so a "1920x1080" file can really be portrait).
3. **Plan the ladder.** 360p / 720p / 1080p by the *short* side, never
   upscaling; a 720p upload gets two rungs, a 320x240 upload gets one at its
   own size.
4. **Transcode** in a single FFmpeg run (decode once, split, scale per rung) to
   H.264/AAC HLS with 4 s fMP4 segments:
   - keyframes forced every 2 s and scene-cut keyframes disabled, so every
     rendition has keyframes at the same timestamps and the player can switch
     at any segment boundary
   - constant frame rate output (snapped to 24/25/30/50/60). Phone clips are
     often variable frame rate, and that's what causes audio to slowly drift out
     of sync after transcoding; `aresample=async=1` keeps audio locked too
   - per-rung bitrate with `maxrate` / `bufsize` so segments stay close to the
     advertised bandwidth
5. Grab a **thumbnail** 10% into the video.
6. Upload playlists, segments and thumbnail to the processed bucket
   (segments cached as immutable, playlists for 60 s) and mark the video
   `processed` with its duration and URLs.
7. On any error the video is marked `failed` with the reason. Temp files are
   removed either way.

Storage, Firestore and FFmpeg are passed into `processUpload()`, so the tests
can run the whole flow with fakes.

### Firestore

| collection | written by | fields |
|---|---|---|
| `users` | `createUser` | uid, email, displayName, photoUrl |
| `videos` | functions + processing service | uid, title, status, playlistUrl, thumbnailUrl, durationSec, resolutions |
| `playbackSessions` | watch page | uid, videoId, ttffMs, rebufferCount, rebufferMs, watchedSec, switches |

Rules are in `firestore.rules`: anyone can read processed videos, only you can
read your own unprocessed ones, and clients can only create playback sessions
for themselves.

## Tests

```sh
cd video-processing-service && npm install && npm test
```

- FFmpeg argument builder: which rungs a source gets (landscape, portrait,
  odd sizes, tiny sources, no upscaling), the bitrate ladder, keyframe and CFR
  settings, silent videos, thumbnail position
- ffprobe parsing, including rotation from side data and from the old tag
- the processor with fakes: happy path, duplicate delivery, a failure at each
  step (marked failed, temp dir cleaned up)
- one integration test that makes a 9 s 29.97 fps clip with FFmpeg, runs the
  real transcode, and checks the master playlist (2 rungs, no 1080p), 4 s
  segments, a keyframe exactly every 2 s and ~270 frames at a constant 30 fps

Plus `api-service` input validation and the web client's playback metrics.
CI runs all of it, builds the Next.js app and the Docker image.

## Running it yourself

You need a Firebase project on the Blaze plan (Cloud Functions and Cloud Run
need billing) and the `gcloud` and `firebase` CLIs.

```sh
PROJECT=your-project
REGION=us-central1
gcloud config set project $PROJECT

# buckets
gcloud storage buckets create gs://$PROJECT-raw-videos --location=$REGION
gcloud storage buckets create gs://$PROJECT-processed-videos --location=$REGION
gcloud storage buckets add-iam-policy-binding gs://$PROJECT-processed-videos \
  --member=allUsers --role=roles/storage.objectViewer
gcloud storage buckets update gs://$PROJECT-raw-videos --cors-file=cors.json
gcloud storage buckets update gs://$PROJECT-processed-videos --cors-file=cors.json

# processing service
cd video-processing-service
gcloud run deploy video-processing-service --source . --region $REGION \
  --memory 4Gi --cpu 2 --timeout 3600 --concurrency 1 --max-instances 3 \
  --no-allow-unauthenticated \
  --set-env-vars PROCESSED_BUCKET=$PROJECT-processed-videos
cd ..

# raw bucket -> Pub/Sub -> Cloud Run
gcloud pubsub topics create video-uploads
gcloud storage buckets notifications create gs://$PROJECT-raw-videos \
  --topic=video-uploads --event-types=OBJECT_FINALIZE
gcloud pubsub subscriptions create video-uploads-push --topic=video-uploads \
  --push-endpoint="$(gcloud run services describe video-processing-service \
      --region $REGION --format='value(status.url)')/process-video" \
  --push-auth-service-account=<a service account with run.invoker> \
  --ack-deadline=600

# functions, rules, indexes
echo "RAW_VIDEOS_BUCKET=$PROJECT-raw-videos" > api-service/.env
(cd api-service && npm install)
firebase deploy --only functions,firestore

# web client
cd web-client
cp .env.example .env.local   # fill in from the Firebase console
npm install && npm run dev
```

Add your deployed origin to `cors.json` too. The functions' service account
needs `roles/iam.serviceAccountTokenCreator` on itself to sign URLs.

## Things I'd do next

- Resumable uploads. Right now it's one big PUT, so a dropped connection
  on a large file means starting over.
- Processing is one long request, which caps a video at Cloud Run's 60 minute
  timeout. Splitting the transcode by rendition (or by chunk) across jobs
  would fix that and finish faster.
- A dashboard over `playbackSessions`: TTFF and rebuffer ratio by rung, which
  is how you'd actually tune the ladder.
