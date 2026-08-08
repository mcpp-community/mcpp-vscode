const vscode = require("vscode");

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("clangd.restart", () => undefined),
  );
}

module.exports = { activate };
