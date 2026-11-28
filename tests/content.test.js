const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const contentScript = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

class FakeElement {
  constructor(className = "") {
    this.className = className;
    this.visible = true;
    this.attributes = {};
    this.children = [];
    this.id = "";
  }

  matches(selector) {
    return selector.split(",").some(part => {
      const classes = part.trim().split(".").filter(Boolean);
      return classes.every(className => this.className.split(/\s+/).includes(className));
    });
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  getClientRects() {
    return this.visible ? [this] : [];
  }
}

class FakeText extends FakeElement {
  constructor(text) {
    super("text");
    this.innerText = text;
    this.textContent = text;
  }

  querySelectorAll() {
    return [];
  }
}

class FakeMenu extends FakeElement {
  constructor({ muted = false, hasDelete = true, closeOnMute = true, onDelete, onMute }) {
    super("menu-items");
    this.muted = muted;
    this.hasDelete = hasDelete;
    this.closeOnMute = closeOnMute;
    this.onDelete = onDelete;
    this.onMute = onMute;
    this.muteItem = new FakeElement("mute");
    this.muteItem.querySelector = selector =>
      selector === ".checked-icon" ? this.muteItem.checkedIcon || null : null;
    this.deleteItem = hasDelete ? new FakeElement("delete") : null;
    this.checkedIcon = muted ? new FakeElement("checked-icon") : null;
    if (this.checkedIcon) this.muteItem.checkedIcon = this.checkedIcon;
    this.muteItem.click = () => {
      this.muted = true;
      this.checkedIcon = new FakeElement("checked-icon");
      this.muteItem.checkedIcon = this.checkedIcon;
      if (this.closeOnMute) this.visible = false;
      if (this.onMute) this.onMute();
    };
    if (this.deleteItem) {
      this.deleteItem.click = () => {
        this.onDelete();
        this.visible = false;
      };
    }
  }

  querySelector(selector) {
    if (selector === "li.mute") return this.muteItem;
    if (selector === "li.delete") return this.deleteItem;
    if (selector === ".checked-icon") return this.muteItem.checkedIcon || null;
    return null;
  }
}

class FakeDialog extends FakeElement {
  constructor({
    visible = false,
    text = "آیا از حذف پیام اطمینان دارید؟",
    hasConfirm = true,
    hasCancel = true,
    onConfirm,
    onCancel
  } = {}) {
    super("dialog dialog-warning");
    this.visible = visible;
    this.content = new FakeElement("dialog-content");
    this.content.innerText = text;
    this.content.textContent = text;
    this.buttons = [];

    if (hasCancel) this.buttons.push(this.createButton("انصراف", onCancel));
    if (hasConfirm) this.buttons.push(this.createButton("تایید", onConfirm));
  }

  createButton(label, onClick) {
    const button = new FakeElement("btn");
    const text = new FakeElement("btn-text");
    text.innerText = label;
    text.textContent = label;
    button.querySelector = selector => selector === ".btn-text" ? text : null;
    button.click = () => {
      if (onClick) onClick();
      this.visible = false;
    };
    return button;
  }

  querySelector(selector) {
    return selector === ".dialog-content" ? this.content : null;
  }

  querySelectorAll(selector) {
    return selector === "button" ? this.buttons : [];
  }
}

class FakeMessage extends FakeElement {
  constructor({ text, userId = "user-1", messageId, id = "", menu }) {
    super("chat-msg user-chat-msg");
    this.text = new FakeText(text);
    this.innerText = text;
    this.id = id;
    this.attributes["data-userid"] = userId;
    if (messageId) this.attributes["data-message-id"] = messageId;
    this.menu = menu;
    this.buttons = [{ click: () => {
      this.menu.activeMessage = this;
      this.menu.visible = true;
    } }];
  }

  querySelector(selector) {
    if (selector === ".text") return this.text;
    return null;
  }

  querySelectorAll(selector) {
    if (selector === ".message-commands button") return this.buttons;
    return [];
  }
}

function createHarness({
  enabled = true,
  deleteMessages = false,
  mutedCount = 0,
  menuOptions = {},
  dialogOptions = {}
} = {}) {
  let observerCallback;
  let storageChangedListener;
  const storage = { enabled, deleteMessages, mutedCount };
  const results = { deleted: [], cancelled: [], errors: [], warnings: [] };
  let dialog;
  const menu = new FakeMenu({
    ...menuOptions,
    onDelete: () => {
      if (dialogOptions.onOpen) dialogOptions.onOpen();
      if (dialogOptions.hasDialog !== false) {
        dialog.activeMessage = menu.activeMessage;
        dialog.visible = true;
      }
    }
  });
  menu.onMute = menuOptions.onMute;
  dialog = new FakeDialog({
    hasConfirm: dialogOptions.hasConfirm,
    hasCancel: dialogOptions.hasCancel,
    text: dialogOptions.text,
    onConfirm: () => results.deleted.push(dialog.activeMessage),
    onCancel: () => results.cancelled.push(dialog.activeMessage)
  });
  const dialogs = [];
  if (dialogOptions.preexisting) {
    dialogs.push(new FakeDialog({
      visible: true,
      onConfirm: () => results.deleted.push(null),
      onCancel: () => results.cancelled.push(null)
    }));
  }
  if (dialogOptions.hasDialog !== false) dialogs.push(dialog);

  class FakeMutationObserver {
    constructor(callback) {
      observerCallback = callback;
    }

    observe() {}
  }

  const context = {
    window: {},
    document: {
      documentElement: new FakeElement(),
      querySelectorAll: selector => {
        if (selector === "ul.menu-items") return [menu];
        if (selector === "div.dialog.dialog-warning") return dialogs;
        return [];
      }
    },
    chrome: {
      storage: {
        local: {
          get(defaults, callback) {
            const value = { ...defaults, ...storage };
            if (callback) callback(value);
            return Promise.resolve(value);
          },
          set(values) {
            Object.assign(storage, values);
            return Promise.resolve();
          }
        },
        onChanged: { addListener(listener) { storageChangedListener = listener; } }
      }
    },
    MutationObserver: FakeMutationObserver,
    HTMLElement: FakeElement,
    Element: FakeElement,
    getComputedStyle: element => ({
      display: element.visible ? "block" : "none",
      visibility: "visible",
      opacity: "1"
    }),
    setTimeout,
    Date,
    console: {
      info() {},
      warn(...args) { results.warnings.push(args); },
      error(...args) { results.errors.push(args); }
    }
  };

  vm.runInNewContext(contentScript, context, { filename: "content.js" });

  return {
    storage,
    results,
    menu,
    dialog,
    addMessage(message) {
      observerCallback([{ addedNodes: [message] }]);
    },
    setDeleteMessages(value) {
      storage.deleteMessages = value;
      storageChangedListener({ deleteMessages: { newValue: value } }, "local");
    },
    createMessage(options) {
      return new FakeMessage({ ...options, menu });
    }
  };
}

async function waitFor(predicate, timeout = 2500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for message processing");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("mutes a link sender, deletes the message, and increments the count once", async () => {
  const harness = createHarness({ deleteMessages: true });
  const message = harness.createMessage({ text: "https://example.com", messageId: "link-1" });
  harness.addMessage(message);

  await waitFor(() => harness.results.deleted.length === 1 || harness.results.errors.length > 0);

  assert.deepEqual(harness.results.errors, []);
  assert.deepEqual(harness.results.deleted, [message]);
  assert.deepEqual(harness.results.cancelled, []);
  assert.equal(harness.dialog.visible, false);
  assert.equal(harness.storage.mutedCount, 1);
  assert.equal(harness.results.errors.length, 0);
});

test("does not confirm a matching dialog that was already open", async () => {
  const harness = createHarness({
    deleteMessages: true,
    dialogOptions: { hasDialog: false, preexisting: true }
  });
  const message = harness.createMessage({ text: "https://example.com", messageId: "stale-dialog" });
  harness.addMessage(message);

  await waitFor(() => harness.results.errors.length === 1, 2200);

  assert.deepEqual(harness.results.deleted, []);
  assert.equal(harness.results.cancelled.length, 0);
  assert.equal(harness.results.errors.length, 1);
  assert.equal(harness.storage.mutedCount, 1);
});

test("does not confirm a visible dialog with unrelated text", async () => {
  const harness = createHarness({
    deleteMessages: true,
    dialogOptions: { text: "آیا از خروج اطمینان دارید؟" }
  });
  const message = harness.createMessage({ text: "@channel_id", messageId: "unrelated-dialog" });
  harness.addMessage(message);

  await waitFor(() => harness.results.errors.length === 1, 2200);

  assert.deepEqual(harness.results.deleted, []);
  assert.equal(harness.dialog.visible, true);
  assert.equal(harness.storage.mutedCount, 1);
});

test("does not delete when the confirmation button is missing", async () => {
  const harness = createHarness({
    deleteMessages: true,
    dialogOptions: { hasConfirm: false }
  });
  const message = harness.createMessage({ text: "https://example.com", messageId: "no-confirm" });
  harness.addMessage(message);

  await waitFor(() => harness.results.errors.length === 1);

  assert.deepEqual(harness.results.deleted, []);
  assert.equal(harness.dialog.visible, true);
  assert.equal(harness.storage.mutedCount, 1);
});

test("cancels the delete dialog if automatic deletion is disabled before confirmation", async () => {
  let harness;
  harness = createHarness({
    deleteMessages: true,
    dialogOptions: { onOpen: () => harness.setDeleteMessages(false) }
  });
  const message = harness.createMessage({ text: "@channel_id", messageId: "cancel-delete" });
  harness.addMessage(message);

  await waitFor(() => harness.results.cancelled.length === 1 || harness.results.errors.length > 0);

  assert.deepEqual(harness.results.errors, []);
  assert.deepEqual(harness.results.deleted, []);
  assert.deepEqual(harness.results.cancelled, [message]);
  assert.equal(harness.dialog.visible, false);
  assert.equal(harness.storage.mutedCount, 1);
});

test("deletes a channel-ID message even when its sender was already muted", async () => {
  const harness = createHarness({ deleteMessages: true, mutedCount: 4, menuOptions: { muted: true } });
  const message = harness.createMessage({ text: "@mathteacher", messageId: "channel-1" });
  harness.addMessage(message);

  await waitFor(() => harness.results.deleted.length === 1);

  assert.deepEqual(harness.results.deleted, [message]);
  assert.equal(harness.storage.mutedCount, 4);
});

test("reopens a menu that closes after muting before deleting", async () => {
  const harness = createHarness({ deleteMessages: true, menuOptions: { closeOnMute: true } });
  const message = harness.createMessage({ text: "www.example.com", messageId: "closes-1" });
  harness.addMessage(message);

  await waitFor(() => harness.results.deleted.length === 1);

  assert.equal(harness.storage.mutedCount, 1);
});

test("uses the open menu when muting leaves it visible", async () => {
  const harness = createHarness({ deleteMessages: true, menuOptions: { closeOnMute: false } });
  const message = harness.createMessage({ text: "@channel_id", messageId: "open-1" });
  harness.addMessage(message);

  await waitFor(() => harness.results.deleted.length === 1);

  assert.equal(harness.storage.mutedCount, 1);
});

test("serializes messages and processes identical text from distinct message elements", async () => {
  const harness = createHarness({ deleteMessages: true });
  const first = harness.createMessage({ text: "https://example.com", userId: "user-1" });
  const second = harness.createMessage({ text: "https://example.com", userId: "user-1" });
  harness.addMessage(first);
  harness.addMessage(second);

  await waitFor(() => harness.results.deleted.length === 2);

  assert.deepEqual(harness.results.deleted, [first, second]);
  assert.equal(harness.storage.mutedCount, 1);
});

test("does not mute or mark a message processed when delete is unavailable", async () => {
  const harness = createHarness({ deleteMessages: true, menuOptions: { hasDelete: false } });
  const message = harness.createMessage({ text: "https://example.com", messageId: "no-delete" });
  harness.addMessage(message);

  await waitFor(() => harness.results.errors.length === 1);

  assert.equal(harness.results.deleted.length, 0);
  assert.equal(harness.storage.mutedCount, 0);

  harness.menu.deleteItem = new FakeElement("delete");
  harness.menu.deleteItem.click = () => {
    harness.results.deleted.push(message);
    harness.menu.visible = false;
  };
  harness.addMessage(message);

  await waitFor(() => harness.results.deleted.length === 1);

  assert.equal(harness.storage.mutedCount, 1);
});

test("reports a missing visible menu and does not increment the count", async () => {
  const harness = createHarness({ deleteMessages: true });
  harness.menu.visible = false;
  const message = harness.createMessage({ text: "@channel_id", messageId: "no-menu" });
  message.buttons = [{ click() {} }];
  harness.addMessage(message);

  await waitFor(() => harness.results.errors.length + harness.results.warnings.length === 1, 2200);

  assert.equal(harness.results.deleted.length, 0);
  assert.equal(harness.storage.mutedCount, 0);
});

test("mutes a link sender without requiring or selecting delete when deletion is disabled", async () => {
  const harness = createHarness({ menuOptions: { hasDelete: false } });
  const message = harness.createMessage({ text: "https://example.com", messageId: "mute-only" });
  harness.addMessage(message);

  await waitFor(() => harness.storage.mutedCount === 1 || harness.results.errors.length > 0);

  assert.deepEqual(harness.results.errors, []);
  assert.equal(harness.results.deleted.length, 0);
  assert.equal(harness.storage.mutedCount, 1);
});

test("honors disabling deletion while the mute action is in progress", async () => {
  const harness = createHarness({
    deleteMessages: true,
    menuOptions: { onMute: () => harness.setDeleteMessages(false) }
  });
  const message = harness.createMessage({ text: "@channel_id", messageId: "disable-during-mute" });
  harness.addMessage(message);

  await waitFor(() => harness.storage.mutedCount === 1 || harness.results.errors.length > 0);

  assert.deepEqual(harness.results.errors, []);
  assert.equal(harness.results.deleted.length, 0);
  assert.equal(harness.storage.mutedCount, 1);
});

test("honors enabling deletion while the mute action is in progress", async () => {
  const harness = createHarness({
    menuOptions: { onMute: () => harness.setDeleteMessages(true) }
  });
  const message = harness.createMessage({ text: "https://example.com", messageId: "enable-during-mute" });
  harness.addMessage(message);

  await waitFor(() => harness.results.deleted.length === 1 || harness.results.errors.length > 0);

  assert.deepEqual(harness.results.errors, []);
  assert.deepEqual(harness.results.deleted, [message]);
  assert.equal(harness.storage.mutedCount, 1);
});

test("leaves a message from an already muted sender when deletion is disabled", async () => {
  const harness = createHarness({ menuOptions: { muted: true, hasDelete: false } });
  const message = harness.createMessage({ text: "@channel_id", messageId: "already-muted-no-delete" });
  harness.addMessage(message);

  await new Promise(resolve => setTimeout(resolve, 30));

  assert.deepEqual(harness.results.errors, []);
  assert.equal(harness.results.deleted.length, 0);
  assert.equal(harness.storage.mutedCount, 0);
});

test("does not process messages while disabled", async () => {
  const harness = createHarness({ enabled: false });
  const message = harness.createMessage({ text: "https://example.com", messageId: "disabled" });
  harness.addMessage(message);
  await new Promise(resolve => setTimeout(resolve, 30));

  assert.equal(harness.results.deleted.length, 0);
  assert.equal(harness.storage.mutedCount, 0);
});