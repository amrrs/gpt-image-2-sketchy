// Trace — result page logic.
// 1. Calls the fal.ai queue REST API to run the sketch workflow.
// 2. Reveals the sketch with an animation, then enables the before/after
//    slider as the primary viewing mode.
// 3. Generates a side-by-side share card to clipboard for one-click sharing.

const QUEUE_BASE = "https://queue.fal.run";
const WORKFLOW = "workflows/abdul-7gw2467hshf7/gpt-image-2-sketch";

const params = new URLSearchParams(location.search);
const requestId = params.get("id");
const PENDING_PREFIX = "pending:";

// Resolved after we look up the token. Never read from the URL — that
// path was an unauthorized-request vector. See background.js.
let imageUrl = null;

const stage = document.getElementById("stage");
const srcImg = document.getElementById("srcImg");
const sketchImg = document.getElementById("sketchImg");
const sketchClip = document.getElementById("sketchClip");
const handle = document.getElementById("handle");
const overlay = document.getElementById("overlay");
const statusTitle = document.getElementById("statusTitle");
const statusDetail = document.getElementById("statusDetail");
const copyShareBtn = document.getElementById("copyShare");
const tweetBtn = document.getElementById("tweet");
const downloadLink = document.getElementById("download");
const againBtn = document.getElementById("again");
const logEl = document.getElementById("log");
const toast = document.getElementById("toast");

let sketchUrl = null;

// ---------- logging ----------
function log(msg, isErr = false) {
  const line = document.createElement("div");
  if (isErr) line.className = "err";
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function showToast(msg, ms = 1800) {
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), ms);
}

function setStatus(title, detail) {
  statusTitle.textContent = title;
  if (detail !== undefined) statusDetail.textContent = detail;
}

function fail(msg) {
  setStatus("Failed", msg);
  log(msg, true);
}

// ---------- before/after slider ----------
let sliderPos = 50; // percent

function updateSlider(pos) {
  sliderPos = Math.max(0, Math.min(100, pos));
  sketchClip.style.clipPath = `inset(0 0 0 ${sliderPos}%)`;
  handle.style.left = `${sliderPos}%`;
}

function bindSlider() {
  let dragging = false;
  const setFromEvent = (e) => {
    const rect = stage.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    updateSlider((x / rect.width) * 100);
  };
  stage.addEventListener("mousedown", (e) => { dragging = true; setFromEvent(e); });
  window.addEventListener("mousemove", (e) => { if (dragging) setFromEvent(e); });
  window.addEventListener("mouseup", () => (dragging = false));
  stage.addEventListener("touchstart", (e) => { dragging = true; setFromEvent(e); }, { passive: true });
  window.addEventListener("touchmove", (e) => { if (dragging) setFromEvent(e); }, { passive: true });
  window.addEventListener("touchend", () => (dragging = false));
}

// ---------- fal queue REST flow ----------
async function getApiKey() {
  const { falApiKey } = await chrome.storage.local.get("falApiKey");
  return falApiKey;
}

async function submit(workflow, apiKey, input) {
  const res = await fetch(`${QUEUE_BASE}/${workflow}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${apiKey}`
    },
    body: JSON.stringify(input)
  });
  if (!res.ok) {
    throw new Error(`Submit failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function pollStatus(statusUrl, apiKey) {
  let lastStatus = "";
  while (true) {
    const res = await fetch(statusUrl + "?logs=1", {
      headers: { Authorization: `Key ${apiKey}` }
    });
    if (!res.ok) {
      throw new Error(`Status failed (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    const s = data.status;
    if (Array.isArray(data.logs)) {
      for (const entry of data.logs) {
        if (entry?.message) log(entry.message);
      }
    }
    if (s !== lastStatus) {
      lastStatus = s;
      log(`status: ${s}`);
      if (s === "IN_PROGRESS") setStatus("Tracing your image…", "Running on fal.ai");
      else if (s === "IN_QUEUE") setStatus("Queued…", "Waiting for a worker");
    }
    if (s === "COMPLETED") return data;
    if (s === "FAILED" || s === "CANCELLED") {
      throw new Error(`Run ${s}: ${JSON.stringify(data)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function fetchResult(responseUrl, apiKey) {
  const res = await fetch(responseUrl, {
    headers: { Authorization: `Key ${apiKey}` }
  });
  if (!res.ok) {
    throw new Error(`Result failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

function extractImageUrl(payload) {
  const seen = new Set();
  const stack = [payload];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (typeof node.url === "string" && /^https?:\/\//.test(node.url)) return node.url;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else {
      for (const key of Object.keys(node)) {
        const val = node[key];
        if (typeof val === "string" && /^https?:\/\/\S+\.(png|jpg|jpeg|webp)/i.test(val)) return val;
        if (val && typeof val === "object") stack.push(val);
      }
    }
  }
  return null;
}

// ---------- reveal + share card ----------
function revealSketch(url) {
  sketchUrl = url;
  sketchImg.src = url;
  sketchImg.crossOrigin = "anonymous";
  sketchImg.onload = () => {
    overlay.classList.add("gone");
    // Reveal animation: clip from 100% -> 50%
    sketchClip.style.transition = "none";
    sketchClip.style.clipPath = "inset(0 100% 0 0)";
    requestAnimationFrame(() => {
      sketchClip.style.transition = "clip-path 1.1s cubic-bezier(.65,.05,.36,1)";
      sketchClip.style.clipPath = "inset(0 0 0 50%)";
      setTimeout(() => {
        sketchClip.style.transition = "clip-path 0.06s linear";
        updateSlider(50);
      }, 1200);
    });
    copyShareBtn.disabled = false;
    tweetBtn.disabled = false;
    againBtn.disabled = false;
    downloadLink.href = url;
    downloadLink.style.opacity = "1";
    downloadLink.style.pointerEvents = "auto";
  };
}

// Re-encode the loaded sketch <img> as a PNG blob via canvas. We re-encode
// rather than `fetch().then(r => r.blob())` because the clipboard API
// only accepts a small set of MIME types (image/png most reliably) and
// canvas export normalizes that.
async function sketchAsPngBlob() {
  if (!sketchImg.complete || !sketchImg.naturalWidth) {
    throw new Error("Sketch image not loaded yet.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = sketchImg.naturalWidth;
  canvas.height = sketchImg.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(sketchImg, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png"
    );
  });
}

// Twitter's web-intent URL doesn't support image uploads, so the standard
// workaround is: copy the image to the clipboard, open compose, user
// pastes (Cmd/Ctrl-V). We copy the SKETCH (not the share card) here — the
// share card is what the dedicated "Copy share card" button is for.
async function tweetIt() {
  if (!sketchUrl) return;
  tweetBtn.disabled = true;
  const originalLabel = tweetBtn.innerHTML;
  tweetBtn.innerHTML = "Preparing…";

  let copied = false;
  try {
    const blob = await sketchAsPngBlob();
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": blob })
    ]);
    copied = true;
  } catch (e) {
    log("tweet copy: " + e.message, true);
  }

  const text = "Sketched with Trace ✏️ — powered by fal.ai";
  const intent =
    "https://twitter.com/intent/tweet?text=" + encodeURIComponent(text);
  window.open(intent, "_blank", "noopener,noreferrer");

  if (copied) {
    showToast("Sketch copied — paste it in the tweet (⌘/Ctrl + V)", 4500);
  } else {
    showToast("Twitter doesn't accept attached images — use Download sketch and drag it in.", 5000);
  }

  tweetBtn.disabled = false;
  tweetBtn.innerHTML = originalLabel;
}

// Renders a 1200x630-ish landscape share card with both images side-by-side
// and a "made with Trace · powered by fal.ai" footer mark.
async function buildShareCard() {
  const W = 1200, H = 630;
  const PAD = 32;
  const FOOTER_H = 70;
  const SLOT_W = (W - PAD * 3) / 2;
  const SLOT_H = H - PAD * 2 - FOOTER_H;

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  // background gradient
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#0a0a0f");
  bg.addColorStop(1, "#16162a");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // helper: load an image with CORS
  const load = (src) => new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

  // helper: draw an image fitted into a box, with rounded corners
  const drawFitted = (img, x, y, w, h, r = 16) => {
    const ratio = Math.min(w / img.width, h / img.height);
    const dw = img.width * ratio;
    const dh = img.height * ratio;
    const dx = x + (w - dw) / 2;
    const dy = y + (h - dh) / 2;

    ctx.save();
    // rounded clip on the slot
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = "#0a0a0f";
    ctx.fill();
    ctx.clip();
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
  };

  let before, after;
  try {
    [before, after] = await Promise.all([load(imageUrl), load(sketchUrl)]);
  } catch (e) {
    throw new Error("Couldn't load images for share card (CORS).");
  }

  drawFitted(before, PAD, PAD, SLOT_W, SLOT_H);
  drawFitted(after, PAD * 2 + SLOT_W, PAD, SLOT_W, SLOT_H);

  // labels above each slot
  ctx.font = "600 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.fillText("BEFORE", PAD + 12, PAD + 12);
  ctx.fillStyle = "#8b5cf6";
  ctx.fillText("AFTER", PAD * 2 + SLOT_W + 12, PAD + 12);

  // footer
  const fy = H - FOOTER_H + 8;
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "500 16px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText("made with Trace", PAD, fy + (FOOTER_H - 16) / 2);

  // little fal mark at the right
  const m = 32;
  const mx = W - PAD - m;
  const my = fy + (FOOTER_H - 16) / 2 - m / 2;
  ctx.fillStyle = "#8b5cf6";
  // approximate fal mark with a square + corner cutouts using globalCompositeOperation
  ctx.save();
  ctx.translate(mx, my);
  ctx.fillRect(0, 0, m, m);
  ctx.globalCompositeOperation = "destination-out";
  const cr = m * 0.354;
  for (const [cx, cy] of [[0, 0], [m, 0], [0, m], [m, m]]) {
    ctx.beginPath();
    ctx.arc(cx, cy, cr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(m / 2, m / 2, m * 0.301, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // "powered by fal.ai" text just left of the mark
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = "500 14px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("powered by fal.ai", mx - 8, fy + (FOOTER_H - 16) / 2);
  ctx.textAlign = "left";

  return canvas;
}

async function copyShareCardToClipboard() {
  copyShareBtn.disabled = true;
  copyShareBtn.textContent = "Building card…";
  try {
    const canvas = await buildShareCard();
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": blob })
    ]);
    copyShareBtn.classList.add("copied");
    copyShareBtn.innerHTML = "✓ Copied — paste anywhere";
    showToast("Share card copied to clipboard");
    setTimeout(() => {
      copyShareBtn.classList.remove("copied");
      copyShareBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy share card`;
      copyShareBtn.disabled = false;
    }, 2400);
  } catch (e) {
    log("share card: " + e.message, true);
    showToast("Couldn't copy — try Download instead");
    copyShareBtn.disabled = false;
    copyShareBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy share card`;
  }
}

// Look up the single-use token written by background.js. If the token
// is missing, this page was opened without a legitimate context-menu
// click — refuse to run and don't touch the API key.
async function consumeRequestToken() {
  if (!requestId) return null;
  const key = PENDING_PREFIX + requestId;
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key];
  if (!entry) return null;
  // Single-use: remove immediately so a reload can't replay it.
  await chrome.storage.session.remove(key);
  return entry;
}

function resetForRetry() {
  // Hide the sketch under the overlay again before resubmitting.
  overlay.classList.remove("gone");
  setStatus("Submitting to fal.ai…", "Sending image to the workflow");
  copyShareBtn.disabled = true;
  againBtn.disabled = true;
  tweetBtn.disabled = true;
  downloadLink.style.opacity = "0.4";
  downloadLink.style.pointerEvents = "none";
  sketchClip.style.transition = "none";
  sketchClip.style.clipPath = "inset(0 100% 0 0)";
  sketchUrl = null;
}

// ---------- main ----------
async function submitAndReveal(apiKey) {
  log(`Image: ${imageUrl}`);
  setStatus("Submitting to fal.ai…", "Sending image to the workflow");
  try {
    const submitted = await submit(WORKFLOW, apiKey, { image_url_field: imageUrl });
    log(`Queued: request_id=${submitted.request_id}`);
    const statusUrl = submitted.status_url || `${QUEUE_BASE}/${WORKFLOW}/requests/${submitted.request_id}/status`;
    const responseUrl = submitted.response_url || `${QUEUE_BASE}/${WORKFLOW}/requests/${submitted.request_id}`;
    await pollStatus(statusUrl, apiKey);
    setStatus("Almost there…", "Fetching result");
    log("Completed. Fetching result…");
    const result = await fetchResult(responseUrl, apiKey);
    const url = extractImageUrl(result);
    if (!url) {
      log(JSON.stringify(result, null, 2));
      throw new Error("Could not find an image URL in the workflow output.");
    }
    log("Done.");
    revealSketch(url);
  } catch (err) {
    fail(err.message || String(err));
  }
}

async function run() {
  bindSlider();

  const entry = await consumeRequestToken();
  if (!entry) {
    fail("This page must be opened by right-clicking an image. Right-click any image on the web and choose \"Trace this image (sketch)\".");
    return;
  }
  imageUrl = entry.imageUrl;

  if (!/^(https?:|data:)/i.test(imageUrl)) {
    fail("Unsupported image URL.");
    return;
  }

  srcImg.src = imageUrl;
  srcImg.crossOrigin = "anonymous";

  const apiKey = await getApiKey();
  if (!apiKey) {
    fail("No fal.ai API key set. Click the gear icon to add one.");
    return;
  }

  await submitAndReveal(apiKey);
}

copyShareBtn.addEventListener("click", copyShareCardToClipboard);
tweetBtn.addEventListener("click", tweetIt);
againBtn.addEventListener("click", async () => {
  const apiKey = await getApiKey();
  if (!apiKey || !imageUrl) return;
  resetForRetry();
  await submitAndReveal(apiKey);
});

run();
