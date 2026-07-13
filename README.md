# Niititu Focus Remote Render Worker

Worker untuk render Pomodoro jarak jauh melalui Tailscale. Worker menerima manifest render portable + source files dari Mac backend, menyimpan job JSON, lalu menjalankan pipeline FFmpeg yang sama di ASUS.

## Deploy manual di Windows

1. Salin atau clone folder `worker` ke `D:\Projects\pomodoro-video-factory-worker\app`.
2. Instal Node.js LTS, FFmpeg, dan ffprobe; pastikan `ffmpeg -version` dan `ffprobe -version` bekerja dari Command Prompt.
3. Di `D:\Projects\pomodoro-video-factory-worker\app`, jalankan `npm install`.
4. Salin `.env.example` menjadi `.env`, lalu isi `WORKER_API_TOKEN` dengan secret kuat. Pastikan `WORKER_ROOT=D:\Projects\pomodoro-video-factory-worker`.
5. Jalankan manual dengan `start-worker.cmd` atau `npm start`.

Folder `jobs`, `uploads`, `temp`, `outputs`, dan `logs` dibuat dari `WORKER_ROOT`. Jangan meneruskan port 4010 ke internet publik; akses hanya melalui Tailscale/private network.

## Uji koneksi

Dari ASUS:

```bat
curl http://127.0.0.1:4010/health
```

Dari Mac melalui Tailscale:

```sh
curl http://100.98.130.76:4010/health
```

Status terautentikasi:

```sh
curl -H "Authorization: Bearer YOUR_TOKEN" http://100.98.130.76:4010/api/status
```

Job status:

```sh
curl -H "Authorization: Bearer YOUR_TOKEN" http://100.98.130.76:4010/api/jobs/JOB_ID
```

## Upload render

`POST /api/jobs` memakai `multipart/form-data`:

- field `manifest`: JSON render manifest versi 1
- file fields: logical path seperti `assets/focus-video.mp4`

Worker menolak logical path yang bukan `assets/<filename>` agar upload tidak bisa keluar dari folder job. File disimpan di:

```text
%WORKER_ROOT%\uploads\<jobId>\assets\
%WORKER_ROOT%\temp\<jobId>\
%WORKER_ROOT%\outputs\<jobId>\
```

## Manual integration test pendek

1. Jalankan worker di ASUS: `npm start`.
2. Dari Mac, pastikan health OK: `curl http://100.98.130.76:4010/health`.
3. Di `be/.env` Mac, set `RENDER_MODE=remote`, `REMOTE_WORKER_URL=http://100.98.130.76:4010`, dan token yang sama.
4. Jalankan Mac backend + frontend.
5. Buat project pendek atau preview dengan focus/break video, focus/break audio, dan optional bell.
6. Klik `Generate Preview`.
7. Cek ASUS: file muncul di `%WORKER_ROOT%\uploads\<jobId>\assets\`, job JSON muncul di `%WORKER_ROOT%\jobs\`, dan output FFmpeg dibuat di `%WORKER_ROOT%\outputs\<jobId>\`.
8. Cek frontend: progress berubah dari `Uploading Sources` ke `Queued`/`Rendering`/`Completed` atau `Failed`.

Untuk menghentikan worker yang berjalan di jendela Command Prompt, tekan `Ctrl+C`. Task Scheduler sengaja belum dikonfigurasi.
