// Service worker. Registers the right-click menu, validates the source
// image URL, and hands off the request to the result page via an
// unguessable session-scoped token. The image URL never appears in the
// result page URL — this prevents malicious pages from forging requests
// against the user's fal.ai key.

const MENU_ID = "fal-sketchify-image";
const PENDING_PREFIX = "pending:";
const PENDING_TTL_MS = 5 * 60 * 1000; // tokens expire after 5 minutes

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Trace this image (sketch)",
    contexts: ["image"]
  });
});

function isAllowedImageUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "data:";
  } catch {
    return false;
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const imageUrl = info.srcUrl;
  if (!imageUrl || !isAllowedImageUrl(imageUrl)) return;

  const { falApiKey } = await chrome.storage.local.get("falApiKey");
  if (!falApiKey) {
    chrome.runtime.openOptionsPage();
    return;
  }

  // Generate a single-use, in-memory token. Session storage is not
  // persisted to disk and is cleared when the browser closes.
  const requestId = crypto.randomUUID();
  await chrome.storage.session.set({
    [PENDING_PREFIX + requestId]: {
      imageUrl,
      createdAt: Date.now()
    }
  });

  const resultUrl = chrome.runtime.getURL("result.html") + "?id=" + requestId;
  chrome.tabs.create({ url: resultUrl, index: (tab?.index ?? 0) + 1 });

  // Best-effort cleanup: drop stale tokens.
  pruneExpired();
});

async function pruneExpired() {
  const all = await chrome.storage.session.get(null);
  const now = Date.now();
  const toRemove = [];
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(PENDING_PREFIX)) continue;
    if (!v || typeof v !== "object" || now - (v.createdAt || 0) > PENDING_TTL_MS) {
      toRemove.push(k);
    }
  }
  if (toRemove.length) await chrome.storage.session.remove(toRemove);
}
