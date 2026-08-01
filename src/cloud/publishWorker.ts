/**
 * Runs cloud ingest on a timer inside a Web Worker so background tabs keep
 * publishing even when the main-thread setInterval is heavily throttled.
 *
 * Messages in:
 *   { type: 'config', url, token, intervalMs }
 *   { type: 'payload', body: string }   // latest JSON body to POST
 *   { type: 'flush' }                  // publish immediately if we have a payload
 *   { type: 'stop' }
 *
 * Messages out:
 *   { type: 'result', ok, status?, error?, at }
 */

export interface PublishWorkerConfigMsg {
  type: 'config';
  url: string;
  token: string;
  intervalMs: number;
}

export interface PublishWorkerPayloadMsg {
  type: 'payload';
  body: string;
}

export type PublishWorkerInMsg =
  | PublishWorkerConfigMsg
  | PublishWorkerPayloadMsg
  | { type: 'flush' }
  | { type: 'stop' };

export type PublishWorkerOutMsg = {
  type: 'result';
  ok: boolean;
  status?: number;
  error?: string | null;
  at: number;
};

let url = '';
let token = '';
let intervalMs = 3000;
let latestBody: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
/** After config or empty, publish as soon as the first payload arrives */
let needImmediate = true;

function clearTimer() {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
}

function startTimer() {
  clearTimer();
  if (!url || !token || intervalMs < 500) return;
  timer = setInterval(() => {
    void publish();
  }, intervalMs);
}

async function publish() {
  if (inFlight || !latestBody || !url || !token) return;
  inFlight = true;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: latestBody,
      // Helps complete the request if the page is being backgrounded / frozen
      keepalive: true,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      const msg: PublishWorkerOutMsg = {
        type: 'result',
        ok: false,
        status: res.status,
        error: `${res.status} ${text}`.slice(0, 120),
        at: Date.now(),
      };
      self.postMessage(msg);
      return;
    }
    const msg: PublishWorkerOutMsg = {
      type: 'result',
      ok: true,
      status: res.status,
      error: null,
      at: Date.now(),
    };
    self.postMessage(msg);
  } catch (err) {
    const msg: PublishWorkerOutMsg = {
      type: 'result',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      at: Date.now(),
    };
    self.postMessage(msg);
  } finally {
    inFlight = false;
  }
}

self.onmessage = (ev: MessageEvent<PublishWorkerInMsg>) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'config':
      url = msg.url;
      token = msg.token;
      intervalMs = Math.max(2000, msg.intervalMs || 3000);
      needImmediate = true;
      startTimer();
      void publish();
      break;
    case 'payload':
      latestBody = msg.body;
      if (needImmediate) {
        needImmediate = false;
        void publish();
      }
      break;
    case 'flush':
      void publish();
      break;
    case 'stop':
      clearTimer();
      latestBody = null;
      needImmediate = true;
      break;
    default:
      break;
  }
};
