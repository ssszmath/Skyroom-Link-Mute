(() => {
  "use strict";

  // از اجرای چندباره اسکریپت در یک صفحه جلوگیری می‌کند.
  if (window.__skyroomLinkMuteLoaded) return;
  window.__skyroomLinkMuteLoaded = true;

  let enabled = false;
  const processedMessages = new Set();
  const inProgressMessages = new Set();

  chrome.storage.local.get({ enabled: false }, result => {
    enabled = Boolean(result.enabled);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.enabled) {
      enabled = Boolean(changes.enabled.newValue);
    }
  });

  function isVisible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      element.getClientRects().length > 0;
  }

  function messageHasLink(message) {
    const textContainer = message.querySelector(".text");
    if (!textContainer) return false;

    // لینک‌هایی که اسکای‌روم به صورت anchor رندر کرده است.
    const anchors = [...textContainer.querySelectorAll("a[href]")];
    if (anchors.some(a => /^https?:\/\//i.test(a.href))) return true;

    // پشتیبانی از لینک متنی، حتی اگر به تگ a تبدیل نشده باشد.
    const text = textContainer.innerText || textContainer.textContent || "";
    return /(?:https?:\/\/|www\.)[^\s<]+/i.test(text) ||
      /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?/i.test(text);
  }

  function messageHasChannelId(message) {
    const textContainer = message.querySelector(".text");
    if (!textContainer) return false;

    const text = textContainer.innerText || textContainer.textContent || "";
    // تشخیص آیدی کانال: @ followed by alphanumeric characters and underscores
    // حداقل 3 کاراکتر بعد از @ برای جلوگیری از مثبت کاذب
    return /@[a-z0-9_]{2,}/i.test(text);
  }

  function getMessageKey(message) {
    return message.getAttribute("data-message-id") ||
      message.id ||
      `${message.getAttribute("data-userid") || "unknown"}:${(message.innerText || "").slice(0, 100)}`;
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function waitForVisibleMuteMenu(timeout = 1600) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const menus = [...document.querySelectorAll("ul.menu-items")];
      const menu = menus.find(item =>
        isVisible(item) && item.querySelector("li.mute")
      );
      if (menu) return menu;
      await wait(80);
    }
    return null;
  }

  async function handleMessage(message) {
    if (!enabled) return;
    if (!(message instanceof HTMLElement)) return;
    if (!message.matches(".chat-msg.user-chat-msg")) return;
    if (!messageHasLink(message) && !messageHasChannelId(message)) return;

    const key = getMessageKey(message);
    if (processedMessages.has(key) || inProgressMessages.has(key)) return;

    // فقط یک بار برای هر پیام تلاش می‌کنیم.
    inProgressMessages.add(key);

    try {
      const buttons = message.querySelectorAll(".message-commands button");
      if (!buttons.length) return;

      // در ساختار ارسالی، دکمه دوم همان سه‌نقطه است.
      const moreButton = buttons[buttons.length - 1];
      moreButton.click();

      const menu = await waitForVisibleMuteMenu();
      if (!menu) {
        console.warn("[Skyroom Link Mute] منوی پیام پیدا نشد.");
        return;
      }

      const muteItem = menu.querySelector("li.mute");
      if (!muteItem) return;

      // وجود تیکِ قابل مشاهده یعنی کاربر از قبل ساکت شده است.
      const checkedIcon = muteItem.querySelector(".checked-icon");
      const alreadyMuted = checkedIcon && isVisible(checkedIcon);

      if (!alreadyMuted) {
        muteItem.click();
        processedMessages.add(key);

        const result = await chrome.storage.local.get({ mutedCount: 0 });
        await chrome.storage.local.set({
          mutedCount: (result.mutedCount || 0) + 1
        });

        const reason = messageHasChannelId(message) ? "ارسال آیدی کانال" : "ارسال لینک";
        console.info("[Skyroom Link Mute] کاربر به دلیل " + reason + " ساکت شد.",
          message.getAttribute("data-userid"));
      } else {
        processedMessages.add(key);
        console.info("[Skyroom Link Mute] فرستنده از قبل ساکت بوده است.");
      }
    } catch (error) {
      console.error("[Skyroom Link Mute] خطا در پردازش پیام:", error);
    } finally {
      inProgressMessages.delete(key);
    }
  }

  function inspectAddedNode(node) {
    if (!(node instanceof Element)) return;

    if (node.matches(".chat-msg.user-chat-msg")) {
      handleMessage(node);
    }

    node.querySelectorAll(".chat-msg.user-chat-msg").forEach(handleMessage);
  }

  const observer = new MutationObserver(records => {
    if (!enabled) return;

    for (const record of records) {
      for (const node of record.addedNodes) {
        inspectAddedNode(node);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  console.info("[Skyroom Link Mute] افزونه بارگذاری شد.");
})();
