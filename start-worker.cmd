@echo off
if not exist D:\Projects\pomodoro-video-factory-worker\logs mkdir D:\Projects\pomodoro-video-factory-worker\logs
cd /d D:\Projects\pomodoro-video-factory-worker\app
npm start >> D:\Projects\pomodoro-video-factory-worker\logs\worker.log 2>&1
