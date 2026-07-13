# Niititu Focus Remote Render Worker

Foundation worker untuk render Pomodoro jarak jauh melalui Tailscale. Pada fase ini worker hanya menyediakan health check, autentikasi, dan persistence job JSON; worker belum menerima upload atau menjalankan FFmpeg render.

## Deploy manual di Windows

1. Salin atau clone folder `worker` ke `D:\NiitituWorker\app`.
2. Instal Node.js LTS, FFmpeg, dan ffprobe; pastikan `ffmpeg -version` dan `ffprobe -version` bekerja dari Command Prompt.
3. Di `D:\NiitituWorker\app`, jalankan `npm install`.
4. Salin `.env.example` menjadi `.env`, lalu isi `WORKER_API_TOKEN` dengan secret kuat. Pastikan `WORKER_ROOT=D:\NiitituWorker`.
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

Untuk menghentikan worker yang berjalan di jendela Command Prompt, tekan `Ctrl+C`. Task Scheduler sengaja belum dikonfigurasi.
