const enabledInput = document.getElementById("enabled");
const deleteMessagesInput = document.getElementById("deleteMessages");
const statusText = document.getElementById("statusText");
const mutedCount = document.getElementById("mutedCount");
const resetBtn = document.getElementById("resetBtn");

function render(state) {
  enabledInput.checked = Boolean(state.enabled);
  deleteMessagesInput.checked = Boolean(state.deleteMessages);
  statusText.textContent = state.enabled ? "فعال — لینک‌ها و آیدی کانال‌ها بررسی می‌شوند" : "غیرفعال";
  mutedCount.textContent = new Intl.NumberFormat("fa-IR").format(state.mutedCount || 0);
}

chrome.storage.local.get(
  { enabled: false, deleteMessages: false, mutedCount: 0 },
  render
);

enabledInput.addEventListener("change", async () => {
  const enabled = enabledInput.checked;
  await chrome.storage.local.set({ enabled });
  statusText.textContent = enabled ? "فعال — لینک‌ها و آیدی کانال‌ها بررسی می‌شوند" : "غیرفعال";
});

deleteMessagesInput.addEventListener("change", async () => {
  await chrome.storage.local.set({ deleteMessages: deleteMessagesInput.checked });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  chrome.storage.local.get({ enabled: false, deleteMessages: false, mutedCount: 0 }, render);
});

resetBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ mutedCount: 0 });
  mutedCount.textContent = new Intl.NumberFormat("fa-IR").format(0);
});
