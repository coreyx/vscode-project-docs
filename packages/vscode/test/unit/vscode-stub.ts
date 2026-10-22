/**
 * A stand-in for the `vscode` module in unit tests, which run in plain Node rather than inside VS
 * Code. It records what the code under test asked VS Code to do.
 */
export const calls: { method: string; args: unknown[] }[] = [];

export const window = {
  showInformationMessage: (...args: unknown[]) => {
    calls.push({ method: "window.showInformationMessage", args });
    return Promise.resolve(undefined);
  },
};
