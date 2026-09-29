import { ListEditorModal } from "./list-editor-modal.js";
import * as serverSettings from "./server-settings.js";

function numberField({ name, desc, key, fromStored, toStored }) {
  return {
    name,
    desc,
    render: (setting) => {
      let committed = fromStored(serverSettings.get()[key]);

      setting.addText((text) => {
        text.setValue(String(committed));

        // Commit only on change.
        const commit = () => {
          const n = parseInt(text.getValue(), 10);

          if (!Number.isInteger(n) || n < 0 || n === committed) {
            return;
          }

          committed = n;
          serverSettings.save({ [key]: toStored(n) });
        };

        text.inputEl.addEventListener("blur", commit);
        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            commit();
          }
        });
      });
    },
  };
}

function listField(tab, { name, desc, key, modal }) {
  return {
    name,
    desc,
    render: (setting) => {
      let value = serverSettings.get()[key];

      const setLabel = (btn) =>
        btn.setButtonText(value.length ? `Edit (${value.length})` : "Edit");

      setting.addButton((btn) => {
        setLabel(btn);

        btn.onClick(() => {
          new ListEditorModal(tab.app, {
            title: name,
            placeholder: modal.placeholder,
            emptyNote: modal.emptyNote,
            recommended: modal.recommended,
            values: value,
            onChange: (edited) => {
              value = edited;
              setLabel(btn);
              serverSettings.save({ [key]: value });
            },
          }).open();
        });
      });
    },
  };
}

export { numberField, listField };
