(() => {
  "use strict";

  // از اجرای چندباره اسکریپت در یک صفحه جلوگیری می‌کند.
  if (window.__skyroomLinkMuteLoaded) return;
  window.__skyroomLinkMuteLoaded = true;

  let enabled = false;
  let deleteMessages = false;
  const processedMessages = new Set();
  const inProgressMessages = new Set();
  let messageQueue = Promise.resolve();

  chrome.storage.local.get({ enabled: false, deleteMessages: false }, result => {
    enabled = Boolean(result.enabled);
    deleteMessages = Boolean(result.deleteMessages);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.enabled) {
      enabled = Boolean(changes.enabled.newValue);
    }
    if (area === "local" && changes.deleteMessages) {
      deleteMessages = Boolean(changes.deleteMessages.newValue);
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
      message;
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function waitForVisibleMenu(itemSelector, timeout = 1600) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const menus = [...document.querySelectorAll("ul.menu-items")];
      const menu = menus.find(item =>
        isVisible(item) && item.querySelector(itemSelector)
      );
      if (menu) return menu;
      await wait(80);
    }
    return null;
  }

  function getVisibleDeleteConfirmationDialogs() {
    return [...document.querySelectorAll("div.dialog.dialog-warning")].filter(dialog => {
      if (!isVisible(dialog)) return false;

      const content = dialog.querySelector(".dialog-content");
      const text = content ? (content.innerText || content.textContent || "") : "";
      return text.replace(/\s+/g, " ").trim() === "آیا از حذف پیام اطمینان دارید؟";
    });
  }

  async function waitForNewDeleteConfirmation(previousDialogs, timeout = 1600) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const dialog = getVisibleDeleteConfirmationDialogs().find(item => !previousDialogs.has(item));
      if (dialog) return dialog;
      await wait(80);
    }
    return null;
  }

  function findDialogButton(dialog, label) {
    return [...dialog.querySelectorAll("button")].find(button => {
      const textElement = button.querySelector(".btn-text");
      const text = textElement ? (textElement.innerText || textElement.textContent || "") :
        (button.innerText || button.textContent || "");
      return text.replace(/\s+/g, " ").trim() === label;
    });
  }

  function handleMessage(message) {
    if (!enabled) return;
    if (!(message instanceof HTMLElement)) return;
    if (!message.matches(".chat-msg.user-chat-msg")) return;
    if (!messageHasLink(message) && !messageHasChannelId(message)) return;

    const key = getMessageKey(message);
    if (processedMessages.has(key) || inProgressMessages.has(key)) return;

    inProgressMessages.add(key);

    messageQueue = messageQueue.then(async () => {
      if (!enabled) return;

      const buttons = message.querySelectorAll(".message-commands button");
      if (!buttons.length) {
        throw new Error("دکمه منوی پیام پیدا نشد.");
      }

      // در ساختار ارسالی، دکمه دوم همان سه‌نقطه است.
      const moreButton = buttons[buttons.length - 1];
      moreButton.click();

      let menu = await waitForVisibleMenu("li.mute");
      if (!menu) {
        throw new Error("منوی پیام پیدا نشد.");
      }

      const muteItem = menu.querySelector("li.mute");
      const deleteItem = menu.querySelector("li.delete");
      if (!muteItem || (deleteMessages && !deleteItem)) {
        throw new Error("گزینه حذف پیام در منو پیدا نشد.");
      }

      // وجود تیکِ قابل مشاهده یعنی کاربر از قبل ساکت شده است.
      const checkedIcon = muteItem.querySelector(".checked-icon");
      const alreadyMuted = checkedIcon && isVisible(checkedIcon);

      if (!alreadyMuted) {
        muteItem.click();

        const result = await chrome.storage.local.get({ mutedCount: 0 });
        await chrome.storage.local.set({
          mutedCount: (result.mutedCount || 0) + 1
        });

        const reason = messageHasChannelId(message) ? "ارسال آیدی کانال" : "ارسال لینک";
        console.info("[Skyroom Link Mute] کاربر به دلیل " + reason + " ساکت شد.",
          message.getAttribute("data-userid"));
      } else {
        console.info("[Skyroom Link Mute] فرستنده از قبل ساکت بوده است.");
      }

      if (!deleteMessages) {
        processedMessages.add(key);
        return;
      }

      if (!isVisible(menu)) {
        moreButton.click();
        menu = await waitForVisibleMenu("li.delete");
      }

      if (!deleteMessages) {
        processedMessages.add(key);
        return;
      }

      const messageDeleteItem = menu && menu.querySelector("li.delete");
      if (!messageDeleteItem) {
        throw new Error("گزینه حذف پیام در منو پیدا نشد.");
      }

      const previousDialogs = new Set(getVisibleDeleteConfirmationDialogs());
      messageDeleteItem.click();

      const confirmationDialog = await waitForNewDeleteConfirmation(previousDialogs);
      if (!confirmationDialog) {
        if (!deleteMessages) {
          processedMessages.add(key);
          return;
        }
        throw new Error("دیالوگ تأیید حذف پیام پیدا نشد.");
      }

      if (!deleteMessages) {
        const cancelButton = findDialogButton(confirmationDialog, "انصراف");
        if (cancelButton) {
          cancelButton.click();
        } else {
          console.warn("[Skyroom Link Mute] دکمه انصراف دیالوگ حذف پیدا نشد.");
        }
        processedMessages.add(key);
        return;
      }

      const confirmButton = findDialogButton(confirmationDialog, "تایید");
      if (!confirmButton) {
        throw new Error("دکمه تأیید حذف پیام پیدا نشد.");
      }

      confirmButton.click();
      processedMessages.add(key);
      console.info("[Skyroom Link Mute] پیام حاوی لینک یا آیدی کانال حذف شد.");
    }).catch(error => {
      console.error("[Skyroom Link Mute] خطا در پردازش پیام:", error);
    }).finally(() => {
      inProgressMessages.delete(key);
    });

    return messageQueue;
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
