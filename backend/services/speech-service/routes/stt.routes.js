const fetch = require('node-fetch');
const multer = require('multer');
const { optionalAuth } = require('../middleware/auth');
const { upstreamHttpsAgent } = require('../lib/upstreamAgent');

const router = require('express').Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const TINY_BUFFER_BYTES = 800;

function isWav(buffer) {
  return (
    buffer &&
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  );
}

function azureContentType(file) {
  const buf = file?.buffer;
  if (isWav(buf)) return 'audio/wav; codecs=audio/pcm; samplerate=16000';
  const mime = String(file?.mimetype || '').toLowerCase();
  if (mime.includes('webm')) return 'audio/webm';
  if (mime.includes('ogg')) return 'audio/ogg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'audio/mpeg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'audio/mp4';
  return mime || 'application/octet-stream';
}

router.post('/', optionalAuth, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer) {
      return res.status(400).json({ success: false, message: 'Audio file is required' });
    }

    if (file.buffer.length < TINY_BUFFER_BYTES) {
      return res.json({ success: true, text: '' });
    }

    const key = (process.env.SPEECH_API_KEY || '').trim();
    const region = (process.env.SPEECH_REGION || '').trim();
    if (!key || !region) {
      return res.status(401).json({
        success: false,
        message: 'Speech is not configured on the server (SPEECH_API_KEY / SPEECH_REGION)',
      });
    }

    const language = String(req.body?.language || 'en-US').trim() || 'en-US';
    const url =
      `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
      `?language=${encodeURIComponent(language)}&format=simple`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': azureContentType(file),
        Accept: 'application/json',
      },
      body: file.buffer,
      agent: upstreamHttpsAgent,
    });

    if (response.status === 401 || response.status === 403) {
      return res.status(response.status).json({
        success: false,
        message: 'Speech is not configured or the subscription key was rejected',
      });
    }
    if (response.status === 429) {
      return res.status(429).json({
        success: false,
        message: 'Speech recognition is busy. Try again in a moment.',
      });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error('[stt] Azure error', response.status, detail.slice(0, 300));
      return res.status(502).json({
        success: false,
        message: 'Speech recognition failed',
      });
    }

    const data = await response.json().catch(() => ({}));
    const text = String(data.DisplayText || data.NBest?.[0]?.Display || '').trim();
    return res.json({ success: true, text });
  } catch (error) {
    console.error('[stt]', error?.message || error);
    return res.status(502).json({
      success: false,
      message: 'Speech recognition failed',
    });
  }
});

module.exports = router;
