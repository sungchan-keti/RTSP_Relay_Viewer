const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// FFmpeg 경로: 프로젝트 폴더의 ffmpeg.exe → 시스템 PATH 순으로 탐색
const localFFmpeg = path.join(__dirname, 'ffmpeg.exe');
const FFMPEG_PATH = fs.existsSync(localFFmpeg) ? localFFmpeg : 'ffmpeg';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3000;

// 정적 파일 서빙
app.use(express.static(__dirname));
app.use(express.json());

// 활성 스트림 관리: id -> { ffmpeg, clients, url, retryCount, retryTimer, meta }
const streams = new Map();

// ─── WebSocket 연결 처리 ───
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const id = url.searchParams.get('id');

  if (!id) {
    ws.close();
    return;
  }

  // 스트림이 아직 없으면 대기 목록에 추가
  if (!streams.has(id)) {
    streams.set(id, { ffmpeg: null, clients: new Set(), url: null, retryCount: 0, retryTimer: null });
  }

  const entry = streams.get(id);
  entry.clients.add(ws);
  console.log(`[CH${id}] WebSocket 클라이언트 연결 (총 ${entry.clients.size}명)`);

  ws.on('close', () => {
    entry.clients.delete(ws);
    console.log(`[CH${id}] WebSocket 클라이언트 해제 (총 ${entry.clients.size}명)`);
  });

  ws.on('error', () => {
    entry.clients.delete(ws);
  });
});

// ─── FFmpeg 프로세스 시작 ───
function startFFmpeg(id, rtspUrl) {
  const entry = streams.get(id) || { ffmpeg: null, clients: new Set(), url: rtspUrl, retryCount: 0, retryTimer: null, meta: {} };
  streams.set(id, entry);
  entry.url = rtspUrl;
  entry.meta = { inputCodec: null, inputResolution: null, inputFps: null, outputResolution: null, bitrate: null, fps: null, frames: 0, uptime: null, speed: null };

  // 기존 FFmpeg 종료
  if (entry.ffmpeg) {
    try { entry.ffmpeg.kill('SIGKILL'); } catch (e) {}
    entry.ffmpeg = null;
  }

  console.log(`[CH${id}] FFmpeg 시작: ${rtspUrl}`);

  // 프로토콜별 입력 옵션 분기
  const isRtsp = rtspUrl.toLowerCase().startsWith('rtsp://');
  const isRtmp = rtspUrl.toLowerCase().startsWith('rtmp://');
  const inputArgs = [];

  if (isRtsp) {
    inputArgs.push('-rtsp_transport', 'tcp');    // RTSP: TCP 전송 (안정성)
    inputArgs.push('-timeout', '5000000');       // RTSP 연결 타임아웃 5초
  } else if (isRtmp) {
    inputArgs.push('-rw_timeout', '5000000');    // RTMP 연결 타임아웃 5초
  }

  inputArgs.push(
    '-analyzeduration', '2000000',   // 스트림 분석 시간 2초
    '-probesize', '10000000',        // 프로브 크기 10MB
    '-fflags', '+genpts+discardcorrupt+nobuffer',
    '-i', rtspUrl                    // 입력 URL
  );

  const outputArgs = [
    '-f', 'mpegts',                  // 출력 포맷: MPEG-TS
    '-codec:v', 'mpeg1video',        // JSMpeg 호환 코덱
    '-q:v', '8',                     // 품질 기반 인코딩 (2~31, 낮을수록 고품질)
    '-r', '25',                      // 프레임레이트
    '-s', '960x540',                 // 해상도
    '-an',                           // 오디오 제외
    '-flush_packets', '1',           // 즉시 전송 (저지연)
    'pipe:1'                         // stdout으로 출력
  ];

  console.log(`[CH${id}] FFmpeg 경로: ${FFMPEG_PATH} | 프로토콜: ${isRtsp ? 'RTSP' : isRtmp ? 'RTMP' : 'HTTP/기타'}`);
  const ffmpeg = spawn(FFMPEG_PATH, [...inputArgs, ...outputArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  entry.ffmpeg = ffmpeg;

  // FFmpeg stdout → WebSocket 클라이언트에 브로드캐스트
  ffmpeg.stdout.on('data', (data) => {
    entry.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: true });
      }
    });
  });

  // FFmpeg stderr 파싱: 메타정보 추출
  let stderrBuf = '';
  ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString();
    stderrBuf += msg;

    // 입력 스트림 정보 파싱 (한 번만)
    // 예: Stream #0:0: Video: h264 (Main), yuv420p(progressive), 1920x1080, 30 fps
    if (!entry.meta.inputCodec) {
      const inputMatch = stderrBuf.match(/Input #0[\s\S]*?Stream #0:0.*?Video:\s*(\w+)[^,]*,\s*\w+[^,]*,\s*(\d+x\d+)(?:.*?,\s*([\d.]+)\s*fps)?/);
      if (inputMatch) {
        entry.meta.inputCodec = inputMatch[1].toUpperCase();
        entry.meta.inputResolution = inputMatch[2];
        if (inputMatch[3]) entry.meta.inputFps = parseFloat(inputMatch[3]);
      }
    }

    // 출력 스트림 정보 파싱
    if (!entry.meta.outputResolution) {
      const outputMatch = stderrBuf.match(/Output #0[\s\S]*?Stream #0:0.*?Video:\s*\w+[^,]*,\s*\w+[^,]*,\s*(\d+x\d+)/);
      if (outputMatch) {
        entry.meta.outputResolution = outputMatch[1];
      }
    }

    // 실시간 진행 정보 파싱
    // 예: frame=  123 fps= 25 q=8.0 size=    1234KiB time=00:00:05.00 bitrate=2024.5kbits/s speed=1.0x
    const lines = msg.split('\r');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('frame=') || trimmed.includes('frame=')) {
        const frameMatch = trimmed.match(/frame=\s*(\d+)/);
        const fpsMatch = trimmed.match(/fps=\s*([\d.]+)/);
        const bitrateMatch = trimmed.match(/bitrate=\s*([\d.]+\s*\w*bits\/s)/);
        const timeMatch = trimmed.match(/time=\s*([\d:.]+)/);
        const speedMatch = trimmed.match(/speed=\s*([\d.]+)x/);

        if (frameMatch) entry.meta.frames = parseInt(frameMatch[1]);
        if (fpsMatch) entry.meta.fps = parseFloat(fpsMatch[1]);
        if (bitrateMatch) entry.meta.bitrate = bitrateMatch[1];
        if (timeMatch) entry.meta.uptime = timeMatch[1];
        if (speedMatch) entry.meta.speed = parseFloat(speedMatch[1]);

        process.stdout.write(`\r[CH${id}] frame=${entry.meta.frames} fps=${entry.meta.fps} bitrate=${entry.meta.bitrate} time=${entry.meta.uptime}    `);
      } else if (trimmed && !trimmed.startsWith('frame=')) {
        const sub = trimmed.substring(0, 300);
        if (sub.length > 2) console.log(`[CH${id}] FFmpeg: ${sub}`);
      }
    }
  });

  // FFmpeg 종료 시 자동 재시작
  ffmpeg.on('close', (code) => {
    console.warn(`[CH${id}] FFmpeg 종료 (code: ${code})`);
    entry.ffmpeg = null;

    // 스트림이 아직 활성 상태이고 클라이언트가 있으면 재시작
    if (entry.clients.size > 0 && entry.url) {
      entry.retryCount++;
      if (entry.retryCount > 30) {
        console.error(`[CH${id}] 재시도 한도 초과 (30회), 중단`);
        return;
      }
      const delay = Math.min(entry.retryCount * 2000, 10000);
      console.log(`[CH${id}] ${delay / 1000}초 후 재시작 (${entry.retryCount}회차)...`);
      entry.retryTimer = setTimeout(() => {
        if (entry.clients.size > 0 && entry.url) {
          startFFmpeg(id, entry.url);
        }
      }, delay);
    }
  });

  ffmpeg.on('error', (err) => {
    console.error(`[CH${id}] FFmpeg 실행 오류:`, err.message);
    if (err.message.includes('ENOENT')) {
      console.error('FFmpeg가 설치되어 있지 않거나 PATH에 없습니다.');
      console.error('설치: https://ffmpeg.org/download.html');
    }
  });

  // 정상 연결되면 retryCount 리셋 (5초 후)
  setTimeout(() => {
    if (entry.ffmpeg === ffmpeg && !ffmpeg.killed) {
      entry.retryCount = 0;
    }
  }, 5000);
}

// ─── API: 스트림 시작 ───
app.post('/api/stream/start', (req, res) => {
  const { id, url } = req.body;
  if (!id || !url) {
    return res.status(400).json({ error: 'id와 url이 필요합니다' });
  }

  console.log(`[API] 스트림 시작 요청 - CH${id}: ${url}`);
  startFFmpeg(id.toString(), url);
  res.json({ ok: true, wsUrl: `ws://localhost:${PORT}?id=${id}` });
});

// ─── API: 스트림 중지 ───
app.post('/api/stream/stop', (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'id가 필요합니다' });
  }

  console.log(`[API] 스트림 중지 요청 - CH${id}`);
  stopStream(id.toString());
  res.json({ ok: true });
});

// ─── API: 전체 중지 ───
app.post('/api/stream/stop-all', (req, res) => {
  console.log('[API] 전체 스트림 중지');
  for (const [id] of streams) {
    stopStream(id);
  }
  res.json({ ok: true });
});

// ─── API: 상태 확인 ───
app.get('/api/stream/status', (req, res) => {
  const status = {};
  for (const [id, entry] of streams) {
    status[id] = {
      active: entry.ffmpeg !== null && !entry.ffmpeg.killed,
      clients: entry.clients.size,
      url: entry.url,
      retryCount: entry.retryCount,
      meta: entry.meta || {}
    };
  }
  res.json(status);
});

function stopStream(id) {
  if (streams.has(id)) {
    const entry = streams.get(id);
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    entry.url = null; // 재시작 방지
    if (entry.ffmpeg) {
      try { entry.ffmpeg.kill('SIGKILL'); } catch (e) {}
      entry.ffmpeg = null;
    }
    entry.clients.forEach(c => {
      try { c.close(); } catch (e) {}
    });
    entry.clients.clear();
    streams.delete(id);
  }
}

// ─── 종료 처리 ───
process.on('SIGINT', () => {
  console.log('\n서버 종료 중...');
  for (const [id] of streams) {
    stopStream(id);
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  for (const [id] of streams) {
    stopStream(id);
  }
  process.exit(0);
});

// ─── 서버 시작 ───
server.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log(`  드론 영상 모니터링 서버 실행 중`);
  console.log(`  http://localhost:${PORT}`);
  console.log('='.repeat(50));
  console.log('');
  console.log('  사전 요구사항: FFmpeg (PATH에 등록)');
  console.log('  설치: https://ffmpeg.org/download.html');
  console.log('');
});
