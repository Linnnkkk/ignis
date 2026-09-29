const { Notice } = require("obsidian");
const api = require("./api");
const auth = require("./auth");

function accountSettingDefinition(tab, serverStatus) {
  const { plugin } = tab;

  if (serverStatus.authenticated) {
    return {
      name: "Obsidian Sync account",
      desc: `Signed in as ${serverStatus.name || "unknown"} (${serverStatus.email || "unknown"})`,
      render: (setting) => {
        setting.addButton((btn) => {
          btn.setButtonText("Disconnect");
          btn.buttonEl.addClass("mod-destructive");
          btn.onClick(async () => {
            try {
              await api.logout();
              new Notice("Disconnected from Headless Sync");
              await plugin.loadServerStatus();
            } catch (e) {
              new Notice(`Failed to disconnect: ${e.message}`);
            }
          });
        });
      },
    };
  }

  return {
    name: "Obsidian Sync account",
    desc: "Sign in to your Obsidian account to enable sync.",
    render: (setting) => {
      const localToken = auth.getObsidianSyncToken();

      if (localToken) {
        setting
          .setName("Obsidian Sync account detected")
          .setDesc(`${localToken.name} (${localToken.email})`);

        setting.addButton((btn) => {
          btn
            .setButtonText("Use this account for Headless Sync")
            .setCta()
            .onClick(async () => {
              try {
                await auth.sendTokenToServer(localToken);
                new Notice("Connected to Headless Sync");
                await plugin.loadServerStatus();
              } catch (e) {
                new Notice(`Failed to connect: ${e.message}`);
              }
            });
        });

        return;
      }

      setting.addButton((btn) => {
        btn.setButtonText("Log in to Obsidian Sync").onClick(() => {
          const triggered = auth.triggerLogin(tab.app);

          if (!triggered) {
            new Notice(
              "Could not open login dialog. Try logging in from Settings > General.",
            );
            return;
          }

          tab._cancelWait = auth.waitForLogin(async (token) => {
            tab._cancelWait = null;

            if (token) {
              new Notice(`Detected login: ${token.name}`);
              await plugin.loadServerStatus();
              tab.update();
            }
          });
        });
      });
    },
  };
}

module.exports = { accountSettingDefinition };
