const WebSocket = require('ws');
const { v4: uuid } = require('uuid');
const { config, logger, logClient, logOpenAI } = require('./config');
const { sipMap, cleanupPromises } = require('./state');
const { streamAudio, rtpEvents } = require('./rtp');
const fs = require('fs');
const path = require('path');

// --- transcript helpers ---
function safeCallerId(channelId) {
  const info = sipMap.get(channelId);
  let cid = info?.callerId;
  if (typeof cid === 'object' && cid) {
    cid = cid.number || cid.name || cid.id;
  }
  cid = (cid || '').toString().trim();
  cid = cid.replace(/[^\d+]/g, '');
  return cid || 'unknown';
}

function ensureDailyDir() {
  const root = config.RECORDINGS_DIR || '/var/spool/asterisk/monitor';
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dir = path.join(root, yyyy, mm, dd);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    logger.error(`Failed to create transcripts dir ${dir}: ${e.message}`);
  }
  return dir;
}

function transcriptPath(channelId) {
  const dir = ensureDailyDir();
  const callerId = safeCallerId(channelId);
  return path.join(dir, `conversation-${callerId}-${channelId}.txt`);
}

// Log the path once per file to make debugging easier
const _loggedTranscriptPath = new Set();

function appendTranscript(channelId, who, text) {
  if (!text || !text.trim()) return;
  try {
    const file = transcriptPath(channelId);
    const line = `${new Date().toISOString()} ${who}: ${text}\n`;
    fs.appendFile(file, line, (err) => {
      if (err) {
        logger.error(`Failed to write transcript for ${channelId}: ${err.message}`);
      } else if (!_loggedTranscriptPath.has(file)) {
        _loggedTranscriptPath.add(file);
        logger.info(`Transcript file path for ${channelId}: ${file}`);
      }
    });
  } catch (e) {
    logger.error(`Transcript write error for ${channelId}: ${e.message}`);
  }
}

logger.info('Loading openai.js module');

/**
 * Normalize/validate turn detection settings so we never send invalid values.
 * Only 'server_vad' and 'semantic_vad' are accepted by the API.
 */
function normalizeTurnDetection() {
  const rawType = String(config.VAD_TYPE || 'server_vad').toLowerCase();
  const type = (rawType === 'server_vad' || rawType === 'semantic_vad') ? rawType : 'server_vad';

  // Common numeric guards
  const num = (v, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };

  if (type === 'semantic_vad') {
    // semantic_vad does not use threshold/padding/silence knobs
    return { type: 'semantic_vad' };
  }

  // server_vad defaults
  return {
    type: 'server_vad',
    threshold: num(config.VAD_THRESHOLD, 0.6),
    prefix_padding_ms: num(config.VAD_PREFIX_PADDING_MS, 200),
    silence_duration_ms: num(config.VAD_SILENCE_DURATION_MS, 600),
  };
}

/**
 * Wait until our RTP sender queue is flushed (or a timeout elapses).
 */
async function waitForBufferEmpty(channelId, maxWaitTime = 6000, checkInterval = 10) {
  const channelData = sipMap.get(channelId);
  if (!channelData?.streamHandler) {
    logOpenAI(`No streamHandler for ${channelId}, proceeding`, 'info');
    return true;
  }
  const streamHandler = channelData.streamHandler;
  const startWaitTime = Date.now();

  let audioDurationMs = 1000; // Default minimum
  if (channelData.totalDeltaBytes) {
    audioDurationMs = Math.ceil((channelData.totalDeltaBytes / 8000) * 1000) + 500; // audio len + margin
  }
  const dynamicTimeout = Math.min(audioDurationMs, maxWaitTime);
  logOpenAI(`Using dynamic timeout of ${dynamicTimeout}ms for ${channelId} (estimated audio duration: ${(channelData.totalDeltaBytes || 0) / 8000}s)`, 'info');

  let audioFinishedReceived = false;
  const audioFinishedPromise = new Promise((resolve) => {
    rtpEvents.once('audioFinished', (id) => {
      if (id === channelId) {
        logOpenAI(`Audio finished sending for ${channelId} after ${Date.now() - startWaitTime}ms`, 'info');
        audioFinishedReceived = true;
        resolve();
      }
    });
  });

  const isBufferEmpty = () =>
    (!streamHandler.audioBuffer || streamHandler.audioBuffer.length === 0) &&
    (!streamHandler.packetQueue || streamHandler.packetQueue.length === 0);

  if (!isBufferEmpty()) {
    let lastLogTime = 0;
    while (!isBufferEmpty() && (Date.now() - startWaitTime) < maxWaitTime) {
      const now = Date.now();
      if (now - lastLogTime >= 50) {
        logOpenAI(
          `Waiting for RTP buffer to empty for ${channelId} | Buffer: ${streamHandler.audioBuffer?.length || 0} bytes, Queue: ${streamHandler.packetQueue?.length || 0} packets`,
          'info'
        );
        lastLogTime = now;
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }
    if (!isBufferEmpty()) {
      logger.warn(`Timeout waiting for RTP buffer to empty for ${channelId} after ${maxWaitTime}ms`);
      return false;
    }
    logOpenAI(`RTP buffer emptied for ${channelId} after ${Date.now() - startWaitTime}ms`, 'info');
  }

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      if (!audioFinishedReceived) {
        logger.warn(`Timeout waiting for audioFinished for ${channelId} after ${dynamicTimeout}ms`);
      }
      resolve();
    }, dynamicTimeout);
  });
  await Promise.race([audioFinishedPromise, timeoutPromise]);

  logOpenAI(`waitForBufferEmpty completed for ${channelId} in ${Date.now() - startWaitTime}ms`, 'info');
  return true;
}

async function startOpenAIWebSocket(channelId, hooks = {}) {
  const { onRedirectRequest, onTerminateRequest } = hooks;
  const OPENAI_API_KEY = config.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    logger.error('OPENAI_API_KEY is missing in config');
    throw new Error('Missing OPENAI_API_KEY');
  }

  let channelData = sipMap.get(channelId);
  if (!channelData) {
    throw new Error(`Channel ${channelId} not found in sipMap`);
  }

  let ws;
  let streamHandler = null;
  let retryCount = 0;
  const maxRetries = 3;
  let isResponseActive = false;
  let totalDeltaBytes = 0;
  let loggedDeltaBytes = 0;
  let segmentCount = 0;
  let responseBuffer = Buffer.alloc(0);
  let messageQueue = [];
  let itemRoles = new Map();
  let lastUserItemId = null;

  // --- graceful terminate flags / guards ---
  let terminateRequested = false;
  let terminateReason = null;
  let terminationInFlight = false;
  let terminationWatchdogStarted = false;

  /** Idempotent finalizer that cleans up the call once playback is fully flushed. */
  const finalizeAndTerminate = async () => {
    if (terminationInFlight) return;
    terminationInFlight = true;
    try {
      // Best-effort wait for RTP to finish.
      await waitForBufferEmpty(channelId, 8000, 10);
      await new Promise((r) => setTimeout(r, 250)); // short tail-silence to ensure PSTN hears the end
    } catch (e) {
      logger.warn(`Graceful terminate wait failed for ${channelId}: ${e.message}`);
    } finally {
      try {
        if (typeof onTerminateRequest === 'function') {
          onTerminateRequest(channelId, terminateReason || 'agent-terminate');
        }
      } catch (e) {
        logger.warn(`onTerminateRequest failed for ${channelId}: ${e.message}`);
      } finally {
        terminateRequested = false;
        terminateReason = null;
      }
    }
  };

  const processMessage = async (response) => {
    try {
      switch (response.type) {
        case 'session.created':
          logClient(`Session created for ${channelId}`);
          break;

        case 'session.updated':
          logOpenAI(`Session updated for ${channelId}`);
          break;

        case 'conversation.item.created':
          logOpenAI(`Conversation item created for ${channelId}`);
          if (response.item && response.item.id && response.item.role) {
            logger.debug(`Item created: id=${response.item.id}, role=${response.item.role} for ${channelId}`);
            itemRoles.set(response.item.id, response.item.role);
            if (response.item.role === 'user') {
              lastUserItemId = response.item.id;
              logOpenAI(`User voice command detected for ${channelId}, stopping current playback`);
              logger.debug(`VAD triggered - Full message for user voice command: ${JSON.stringify(response, null, 2)}`);
              if (streamHandler) {
                streamHandler.stopPlayback();
              }
            }
          }
          break;

        case 'response.created':
          logOpenAI(`Response created for ${channelId}`);
          isResponseActive = true;
          break;

        case 'response.audio.delta':
          if (response.delta) {
            const deltaBuffer = Buffer.from(response.delta, 'base64');
            if (deltaBuffer.length > 0 && !deltaBuffer.every((byte) => byte === 0x7f)) {
              totalDeltaBytes += deltaBuffer.length;
              channelData.totalDeltaBytes = totalDeltaBytes; // Store in channelData
              sipMap.set(channelId, channelData);
              segmentCount++;
              if (totalDeltaBytes - loggedDeltaBytes >= 40000 || segmentCount >= 100) {
                logOpenAI(
                  `Received audio delta for ${channelId}: ${deltaBuffer.length} bytes, total: ${totalDeltaBytes} bytes, estimated duration: ${(totalDeltaBytes / 8000).toFixed(2)}s`,
                  'info'
                );
                loggedDeltaBytes = totalDeltaBytes;
                segmentCount = 0;
              }

              let packetBuffer = deltaBuffer;
              if (totalDeltaBytes === deltaBuffer.length) {
                const silenceDurationMs = config.SILENCE_PADDING_MS || 100;
                const silencePackets = Math.ceil(silenceDurationMs / 20);
                const silenceBuffer = Buffer.alloc(silencePackets * 160, 0x7f);
                packetBuffer = Buffer.concat([silenceBuffer, deltaBuffer]);
                logger.info(`Prepended ${silencePackets} silence packets (${silenceDurationMs} ms) for ${channelId}`);
              }

              if (sipMap.has(channelId) && streamHandler) {
                streamHandler.sendRtpPacket(packetBuffer);
              }
            } else {
              logger.warn(`Received empty or silent delta for ${channelId}`);
            }
          }
          break;

        case 'response.audio_transcript.delta':
          if (response.delta) {
            logger.debug(`Transcript delta for ${channelId}: ${response.delta.trim()}`);
            logger.debug(`Full transcript delta message: ${JSON.stringify(response, null, 2)}`);
          }
          break;

        case 'response.audio_transcript.done': {
          if (response.transcript) {
            logger.debug(`Transcript done - Full message: ${JSON.stringify(response, null, 2)}`);
            const txt = (response.transcript || '').toLowerCase().normalize('NFKC');

            // Save assistant text to transcript
            appendTranscript(channelId, 'ASSISTANT', response.transcript);
            // NEW: also log assistant transcript at INFO level so it's visible with LOG_LEVEL=info
            // (Use logOpenAI wrapper to keep the same [OpenAI] prefix/format)
            logOpenAI(`Assistant transcription for ${channelId}: ${response.transcript}`, 'info');
            // --- TERMINATE: mark only; do NOT cleanup yet
            if (Array.isArray(config.AGENT_TERMINATE_PHRASES) && config.AGENT_TERMINATE_PHRASES.length) {
              const matched = config.AGENT_TERMINATE_PHRASES.find((p) => txt.includes(p));
              if (matched) {
                terminateRequested = true;
                terminateReason = matched;
                logger.info(
                  `Assistant termination phrase matched ("${matched}") for ${channelId}; will terminate after playback completes`
                );

                // Start a one-shot watchdog in case 'response.audio.done' never arrives.
                if (!terminationWatchdogStarted) {
                  terminationWatchdogStarted = true;
                  setTimeout(() => {
                    if (terminateRequested && !terminationInFlight) {
                      logger.warn(`Termination watchdog firing for ${channelId} — proceeding to finalize`);
                      finalizeAndTerminate();
                    }
                  }, Number(config.TERMINATION_WATCHDOG_MS || 8000)).unref();
                }
              }
            }

            // --- REDIRECT: assistant offers human/queue handoff
            if (Array.isArray(config.REDIRECTION_PHRASES) && config.REDIRECTION_PHRASES.length) {
              const matched = config.REDIRECTION_PHRASES.find((p) => txt.includes(p));
              if (matched && typeof onRedirectRequest === 'function') {
                logger.info(
                  `Assistant redirect phrase matched ("${matched}") for ${channelId}; requesting queue handoff`
                );
                // Do not set any flags in sipMap here; let asterisk.js own the redirect state.
                onRedirectRequest(channelId, matched);
              }
            }
          }
          break;
        }

        case 'conversation.item.input_audio_transcription.delta':
          if (response.delta) {
            logger.debug(`User transcript delta for ${channelId}: ${response.delta.trim()}`);
            logger.debug(`Full user transcript delta message: ${JSON.stringify(response, null, 2)}`);
          }
          break;

        case 'conversation.item.input_audio_transcription.completed':
          if (response.transcript) {
            logger.debug(`User transcript completed - Full message: ${JSON.stringify(response, null, 2)}`);
            logOpenAI(`User command transcription for ${channelId}: ${response.transcript}`, 'info');
            appendTranscript(channelId, 'USER', response.transcript);
          }
          break;

        case 'response.audio.done':
          logOpenAI(
            `Response audio done for ${channelId}, total delta bytes: ${totalDeltaBytes}, estimated duration: ${(totalDeltaBytes / 8000).toFixed(2)}s`,
            'info'
          );
          isResponseActive = false;
          loggedDeltaBytes = 0;
          segmentCount = 0;
          itemRoles.clear();
          lastUserItemId = null;
          responseBuffer = Buffer.alloc(0);

          // If assistant asked to terminate, finalize now (defensive against WS errors)
          if (terminateRequested) {
            await finalizeAndTerminate();
          }
          break;

        case 'error':
          // Log API error but ensure termination still proceeds if it was requested.
          logger.error(`OpenAI error for ${channelId}: ${response.error?.message || 'unknown error'}`);
          try { ws && ws.close(); } catch (_) {}
          if (terminateRequested) {
            // WS error must not prevent us from hanging up the call.
            finalizeAndTerminate();
          }
          break;

        default:
          logger.debug(`Unhandled event type: ${response.type} for ${channelId}`);
          break;
      }
    } catch (e) {
      logger.error(`Error processing message for ${channelId}: ${e.message}`);
    }
  };

  const connectWebSocket = () => {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(config.REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      ws.on('open', async () => {
        logClient(`OpenAI WebSocket connected for ${channelId}`);

        // Build a safe turn_detection payload
        const turn_detection = normalizeTurnDetection();

        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              modalities: ['audio', 'text'],
              voice: config.OPENAI_VOICE || 'alloy',
              instructions: config.SYSTEM_PROMPT,
              input_audio_format: 'g711_ulaw',
              output_audio_format: 'g711_ulaw',
              input_audio_transcription: {
                model: config.TRANSCRIPTION_MODEL || 'whisper-1',
                language: config.TRANSCRIPTION_LANGUAGE || 'en',
              },
              turn_detection,
            },
          })
        );
        logClient(`Session updated for ${channelId}`);

        try {
          const rtpSource = channelData.rtpSource || { address: '127.0.0.1', port: 12000 };
          streamHandler = await streamAudio(channelId, rtpSource);
          channelData.ws = ws;
          channelData.streamHandler = streamHandler;
          channelData.totalDeltaBytes = 0; // Initialize totalDeltaBytes
          sipMap.set(channelId, channelData);

          const itemId = uuid().replace(/-/g, '').substring(0, 32);
          logClient(`Sending initial message for ${channelId}: ${config.INITIAL_MESSAGE || 'Hi'}`);
          ws.send(
            JSON.stringify({
              type: 'conversation.item.create',
              item: {
                id: itemId,
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: config.INITIAL_MESSAGE || 'Hi' }],
              },
            })
          );
          ws.send(
            JSON.stringify({
              type: 'response.create',
              response: {
                modalities: ['audio', 'text'],
                instructions: config.SYSTEM_PROMPT,
                output_audio_format: 'g711_ulaw',
              },
            })
          );
          logClient(`Requested response for ${channelId}`);
          isResponseActive = true;
          resolve(ws);
        } catch (e) {
          logger.error(`Error setting up WebSocket for ${channelId}: ${e.message}`);
          reject(e);
        }
      });

      ws.on('message', (data) => {
        try {
          const response = JSON.parse(data.toString());
          logger.debug(`Raw WebSocket message for ${channelId}: ${JSON.stringify(response, null, 2)}`);
          messageQueue.push(response);
        } catch (e) {
          logger.error(`Error parsing WebSocket message for ${channelId}: ${e.message}`);
        }
      });

      ws.on('error', (e) => {
        logger.error(`WebSocket error for ${channelId}: ${e.message}`);
        // If termination was requested, ensure we still end the call
        if (terminateRequested) {
          finalizeAndTerminate();
          return;
        }
        if (retryCount < maxRetries && sipMap.has(channelId)) {
          retryCount++;
          setTimeout(() => connectWebSocket().then(resolve).catch(reject), 1000);
        } else {
          reject(new Error(`Failed WebSocket after ${maxRetries} attempts`));
        }
      });

      const handleClose = () => {
        logger.info(`WebSocket closed for ${channelId}`);
        channelData.wsClosed = true;
        channelData.ws = null;
        sipMap.set(channelId, channelData);
        ws.off('close', handleClose);

        // If we were supposed to terminate, do it even if WS closed abruptly.
        if (terminateRequested) {
          finalizeAndTerminate();
        }

        const cleanupResolve = cleanupPromises.get(`ws_${channelId}`);
        if (cleanupResolve) {
          cleanupResolve();
          cleanupPromises.delete(`ws_${channelId}`);
        }
      };
      ws.on('close', handleClose);
    });
  };

  setInterval(async () => {
    const maxMessages = 5;
    for (let i = 0; i < maxMessages && messageQueue.length > 0; i++) {
      await processMessage(messageQueue.shift());
    }
  }, 25);

  try {
    await connectWebSocket();
  } catch (e) {
    logger.error(`Failed to start WebSocket for ${channelId}: ${e.message}`);
    throw e;
  }
}

module.exports = { startOpenAIWebSocket, transcriptPath };
