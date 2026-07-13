@echo off
if not exist D:\NiitituWorker\logs mkdir D:\NiitituWorker\logs
cd /d D:\NiitituWorker\app
npm start >> D:\NiitituWorker\logs\worker.log 2>&1
