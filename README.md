# YouTubeSkeletonClone

Basic YouTube clone. Sign in with Google, upload a video, and it gets transcoded into 360p/720p/1080p and plays back with adaptive streaming. No comments, likes etc, I mainly wanted to build the upload -> transcode -> stream part.

Stack: TypeScript, Next.js, Firebase (auth, firestore, functions), Cloud Storage, Pub/Sub, Docker + Cloud Run, FFmpeg

## how it works

1. user signs in, `createUser` function makes a user doc
2. `generateUploadUrl` returns a signed URL and the browser uploads the file straight to the raw bucket (doesn't go through a server)
3. the upload triggers a Pub/Sub message which calls the processing service on Cloud Run
4. processing service transcodes it with ffmpeg and uploads the HLS files to the processed bucket
5. home page lists videos with `getVideos`, watch page plays them with hls.js

### video-processing-service

this is the main part. for each upload:
- marks the video as "processing" in firestore. if it's already marked it skips it, since pub/sub can deliver the same message twice
- runs ffprobe to get resolution, duration, fps, rotation
- picks which qualities to make, never upscales (a 720p upload only gets 360p + 720p)
- transcodes to HLS with 4 s segments and a keyframe every 2 s in every quality so the player can switch cleanly
- forces constant frame rate. phone videos are often variable frame rate and that's what made the audio drift out of sync for me
- grabs a thumbnail 10% in
- uploads everything, marks the video "processed". if something fails it's marked "failed", temp files get deleted either way

### web-client

next.js app with a home feed, upload page (with progress bar) and watch page. the watch page also logs time to first frame, rebuffers and quality switches from hls.js events into a `playbackSessions` collection.

## tests

```
cd video-processing-service && npm install && npm test
```

unit tests for the ffmpeg arguments (which qualities, bitrates, keyframes etc), ffprobe parsing, and the processing flow with fake storage/firestore. there's also one test that runs real ffmpeg on a short generated clip and checks the output playlists and keyframes.

## running it

you need a firebase project on the blaze plan. rough steps:

1. create two buckets, raw and processed (processed one public), and set cors with `cors.json`
2. deploy the processing service to cloud run:
   ```
   cd video-processing-service
   gcloud run deploy video-processing-service --source . --memory 4Gi --cpu 2 --timeout 3600 \
     --set-env-vars PROCESSED_BUCKET=<your processed bucket>
   ```
3. create a pub/sub topic, add a storage notification on the raw bucket for OBJECT_FINALIZE, and a push subscription to `<cloud run url>/process-video`
4. put `RAW_VIDEOS_BUCKET=<raw bucket>` in `api-service/.env` and run `firebase deploy --only functions,firestore`
5. `cd web-client`, copy `.env.example` to `.env.local` and fill it in, then `npm install && npm run dev`

## todo
- resumable uploads for big files
- split transcoding into multiple jobs so long videos don't hit the cloud run timeout
- some kind of dashboard for the playback metrics
