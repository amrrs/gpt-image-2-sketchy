const keyInput = document.getElementById("key");
const saveBtn = document.getElementById("save");
const status = document.getElementById("status");

(async function load() {
  const { falApiKey } = await chrome.storage.local.get("falApiKey");
  if (falApiKey) keyInput.value = falApiKey;
})();

saveBtn.addEventListener("click", async () => {
  const falApiKey = keyInput.value.trim();
  if (!falApiKey) {
    status.className = "status err";
    status.textContent = "Please enter an API key.";
    return;
  }
  await chrome.storage.local.set({ falApiKey });
  status.className = "status ok";
  status.textContent = "Saved. Right-click any image to start tracing.";
  setTimeout(() => { status.textContent = ""; status.className = "status"; }, 2000);
});
