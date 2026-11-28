const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const popupScript = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");

function createHarness(initialStorage = {}) {
  const storage = { ...initialStorage };
  const elements = new Map();
  let storageChangedListener;

  function getElement(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        checked: false,
        textContent: "",
        listeners: {},
        addEventListener(event, listener) {
          this.listeners[event] = listener;
        }
      });
    }
    return elements.get(id);
  }

  const context = {
    document: { getElementById: getElement },
    Intl,
    chrome: {
      storage: {
        local: {
          get(defaults, callback) {
            const result = { ...defaults, ...storage };
            if (callback) callback(result);
            return Promise.resolve(result);
          },
          set(values) {
            Object.assign(storage, values);
            if (storageChangedListener) {
              storageChangedListener(Object.fromEntries(
                Object.entries(values).map(([key, newValue]) => [key, { newValue }])
              ), "local");
            }
            return Promise.resolve();
          }
        },
        onChanged: {
          addListener(listener) {
            storageChangedListener = listener;
          }
        }
      }
    }
  };

  vm.runInNewContext(popupScript, context, { filename: "popup.js" });

  return {
    storage,
    elements,
    getElement,
    notifyStorageChange(changes, area = "local") {
      storageChangedListener(changes, area);
    },
    async change(id, checked) {
      const element = getElement(id);
      element.checked = checked;
      await element.listeners.change();
    }
  };
}

test("defaults message deletion to off when opening the popup", () => {
  const harness = createHarness({ enabled: true, mutedCount: 2 });

  assert.equal(harness.getElement("deleteMessages").checked, false);
  assert.equal(harness.getElement("enabled").checked, true);
});

test("persists the deletion switch and restores it when the popup is reopened", async () => {
  const harness = createHarness();

  await harness.change("deleteMessages", true);

  assert.equal(harness.storage.deleteMessages, true);
  const reopened = createHarness(harness.storage);
  assert.equal(reopened.getElement("deleteMessages").checked, true);
});

test("reflects deletion setting changes from another popup", () => {
  const harness = createHarness({ deleteMessages: false });

  harness.storage.deleteMessages = true;
  harness.notifyStorageChange({ deleteMessages: { newValue: true } });

  assert.equal(harness.getElement("deleteMessages").checked, true);
});